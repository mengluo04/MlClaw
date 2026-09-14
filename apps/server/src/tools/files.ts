import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  writeSync,
  type Dirent,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export class ToolError extends Error {}
/** 在字节上限内读取文件，超限时拒绝返回。 */
const boundedRead = (fd: number, limit: number): Buffer => {
  /** 尚未处理完的缓冲数据。 */
  const buffer = Buffer.alloc(limit + 1);
  /** 已读取到缓冲区的字节数。 */
  let used = 0;
  while (used <= limit) {
    /** 本次同步读取实际获得的字节数。 */
    const n = readSync(fd, buffer, used, buffer.length - used, used);
    if (!n) break;
    used += n;
  }
  if (used > limit) throw new ToolError('文件超过大小限制');
  return buffer.subarray(0, used);
};
/** 读取目录项并限制返回数量。 */
const entries = (path: string, limit: number): Dirent[] => {
  /** 当前目录。 */
  const directory = opendirSync(path);
  /** 本次处理结果。 */
  const result: Dirent[] = [];
  try {
    while (result.length < limit) {
      /** 当前处理的条目。 */
      const item = directory.readSync();
      if (!item) break;
      result.push(item);
    }
    return result;
  } finally {
    directory.closeSync();
  }
};
export class Workspace {
  /** 本次操作的根目录。 */
  readonly root: string;
  /** 单个工作区文件允许读取或写入的最大字节数。 */
  readonly maxFileBytes = 65536;
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }
  /** 解析并验证工作区目标路径。 */
  path(input: string, allowMissing = false): string {
    if (
      input.length > 500 ||
      /[\x00-\x1f<>:"|?*]/.test(input) ||
      isAbsolute(input) ||
      input.includes('\\')
    )
      throw new ToolError('路径格式无效，请使用工作目录内的相对路径和正斜线');
    /** 输入相对路径拆分出的目录段。 */
    const parts = input === '.' ? [] : input.split('/');
    if (
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
    )
      throw new ToolError('路径包含不允许的目录或文件名');
    /** 逐级检查过程中到达的绝对路径。 */
    let current = this.root;
    if (realpathSync(this.root) !== this.root || lstatSync(this.root).isSymbolicLink())
      throw new ToolError('工作目录已改变');
    for (/* 逐项处理当前条目索引、片段。 */ const [index, part] of parts.entries()) {
      current = join(current, part);
      if (!existsSync(current)) {
        // existsSync 对悬空链接返回 false，lstat 仍需显式检查。
        try {
          lstatSync(current);
          throw new ToolError('不允许符号链接');
        } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        if (allowMissing && index === parts.length - 1) return current;
        throw new ToolError('路径不存在；请先使用已存在的父目录');
      }
      /** 文件系统状态信息。 */
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
        throw new ToolError('不允许符号链接、目录联接或硬链接');
      /** 解析后的真实文件路径。 */
      const resolved = realpathSync(current);
      /** 真实目标相对授权根目录的路径。 */
      const inside = relative(this.root, resolved);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        throw new ToolError('路径超出授权工作目录');
      if (index < parts.length - 1 && !stat.isDirectory()) throw new ToolError('父路径不是目录');
    }
    return current;
  }
  /** 在路径与大小约束下读取文件字节。 */
  readBytes(input: string, limit = this.maxFileBytes): Buffer {
    /** 当前操作使用的路径。 */
    const path = this.path(input);
    /** 文件系统状态信息。 */
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit) throw new ToolError('只能读取大小符合限制的普通文件');
    /** 已打开的文件描述符。 */
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      /** 文件打开后的状态，用于检测路径替换或链接变化。 */
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.nlink > 1 ||
        opened.size > limit ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev
      )
        throw new ToolError('文件已变化或超出限制');
      return boundedRead(fd, limit);
    } finally {
      closeSync(fd);
    }
  }
  /** 读取指定资源的内容。 */
  read(input: string) {
    /** 已读取的字节数据或目录累计字节量。 */
    const bytes = this.readBytes(input);
    try {
      /** 当前记录的正文内容。 */
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw new Error();
      return content;
    } catch {
      throw new ToolError('文件不是有效 UTF-8 文本');
    }
  }
  /** 读取文件内容哈希；不存在时返回缺失标记。 */
  snapshot(input: string): string {
    /** 当前操作使用的路径。 */
    const path = this.path(input, true);
    if (!existsSync(path)) return 'absent';
    return createHash('sha256').update(this.readBytes(input)).digest('hex');
  }
  /** 在路径与配额限制下写入工作区内容。 */
  write(input: string, content: string, snapshot: string, signal: AbortSignal) {
    return this.writeBytes(input, Buffer.from(content), snapshot, signal);
  }
  /** 遍历工作区统计文件数、目录项数与累计字节，拒绝不安全条目。 */
  usage() {
    /** 等待遍历的相对目录或条目路径。 */
    const queue = ['.'];
    /** 已统计的普通文件数量。 */
    let files = 0;
    /** 已读取的字节数据或目录累计字节量。 */
    let bytes = 0;
    /** 已访问的目录项数量，用于限制遍历规模。 */
    let visited = 0;
    while (queue.length) {
      /** 当前目录。 */
      const directory = queue.shift()!;
      for (/* 逐项处理当前目录或集合条目。 */ const entry of entries(
        this.path(directory),
        5001 - visited,
      )) {
        if (++visited > 5000) throw new ToolError('工作目录条目超过配额扫描上限');
        /** 当前遍历条目相对工作区的路径。 */
        const name = directory === '.' ? entry.name : `${directory}/${entry.name}`;
        // 链接不会被跟随，也不能借它绕过写入边界。
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) queue.push(name);
        else if (entry.isFile()) {
          files++;
          bytes += lstatSync(join(this.root, name)).size;
        } else throw new ToolError('工作目录存在不支持的特殊文件');
      }
    }
    return { files, bytes, entries: visited };
  }
  /** 在工作区写入文件字节并检查大小限制。 */
  writeBytes(input: string, bytes: Buffer, snapshot: string, signal: AbortSignal) {
    if (bytes.length > this.maxFileBytes) throw new ToolError('写入内容超过 64 KiB');
    /** 当前操作使用的路径。 */
    const path = this.path(input, true);
    signal.throwIfAborted();
    if (this.snapshot(input) !== snapshot) throw new ToolError('文件状态已变化，请重新发起调用');
    /** 当前工作区占用量，用于检查文件数和容量配额。 */
    const usage = this.usage();
    /** 覆盖前文件大小，用于计算新增存储占用。 */
    const previousSize = snapshot === 'absent' ? 0 : lstatSync(path).size;
    if (
      usage.bytes - previousSize + bytes.length > 20 * 1024 * 1024 ||
      usage.files + (snapshot === 'absent' ? 1 : 0) > 500
    )
      throw new ToolError('工作目录超过 20 MiB 或 500 文件配额');
    // 校验至写入之间不让出事件循环；创建采用排他模式，覆盖在已校验的句柄上进行。
    const fd = openSync(
      path,
      snapshot === 'absent' ? 'wx' : constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      /** 文件系统状态信息。 */
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink > 1) throw new ToolError('目标不是独立普通文件');
      if (
        snapshot !== 'absent' &&
        createHash('sha256').update(boundedRead(fd, this.maxFileBytes)).digest('hex') !== snapshot
      )
        throw new ToolError('文件已改变，请重新发起调用');
      signal.throwIfAborted();
      /** 当前读取偏移量。 */
      let offset = 0;
      while (offset < bytes.length)
        offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
      ftruncateSync(fd, bytes.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { path: input, bytes: bytes.length };
  }
  /** 在授权工作目录内创建目录。 */
  mkdir(input: string, signal: AbortSignal) {
    signal.throwIfAborted();
    /** 当前操作使用的路径。 */
    const path = this.path(input, true);
    if (path === this.root) throw new ToolError('不能修改工作区根目录');
    if (this.usage().entries >= 5000) throw new ToolError('目录条目超过配额');
    if (existsSync(path)) throw new ToolError('目标已存在');
    mkdirSync(path, { mode: 0o700 });
    return { path: input };
  }
  /** 遍历工作区目录树并应用范围限制。 */
  private tree(input: string, signal: AbortSignal): string[] {
    /** 本次处理结果。 */
    const result: string[] = [];
    /** 等待遍历的相对目录或条目路径。 */
    const queue = [input];
    while (queue.length) {
      signal.throwIfAborted();
      /** 当前遍历条目相对工作区的路径。 */
      const name = queue.pop()!;
      /** 当前操作使用的路径。 */
      const path = this.path(name);
      /** 文件系统状态信息。 */
      const stat = lstatSync(path);
      if (!stat.isDirectory() && !stat.isFile()) throw new ToolError('不支持操作特殊文件');
      result.push(name);
      if (result.length > 5000) throw new ToolError('目录条目超过操作上限');
      if (stat.isDirectory()) {
        for (/* 逐项处理当前目录或集合条目。 */ const entry of entries(path, 5001))
          queue.push(name + '/' + entry.name);
        if (queue.length + result.length > 5000) throw new ToolError('目录条目超过操作上限');
      }
    }
    return result;
  }
  /** 校验源和目标路径后移动工作区文件或目录。 */
  move(source: string, destination: string, signal: AbortSignal) {
    signal.throwIfAborted();
    /** 已校验的移动源绝对路径；已校验的移动目标绝对路径。 */
    const from = this.path(source),
      to = this.path(destination, true);
    if (from === this.root || to === this.root) throw new ToolError('不能移动或覆盖工作区根目录');
    if (existsSync(to)) throw new ToolError('目标已存在，请使用其他名称');
    /** 相对根目录的路径。 */
    const rel = relative(from, to);
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)))
      throw new ToolError('不能把目录移动到自身内部');
    this.tree(source, signal);
    this.path(source);
    this.path(destination, true);
    renameSync(from, to);
    return { source, destination };
  }
  /** 在根目录与路径保护下永久删除条目，可递归删除目录。 */
  remove(input: string, recursive: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    /** 当前操作使用的路径。 */
    const path = this.path(input);
    if (path === this.root) throw new ToolError('不能删除工作区根目录');
    /** 待处理条目列表。 */
    const items = this.tree(input, signal);
    if (!recursive && items.length > 1)
      throw new ToolError('目录非空，删除目录内容需要 recursive=true');
    // 先完整检查所有条目，再逐项删除，不能通过目录内链接越界。
    for (/* 逐项处理当前处理的条目。 */ const item of items.reverse()) {
      signal.throwIfAborted();
      /** 本次处理的目标。 */
      const target = this.path(item);
      if (lstatSync(target).isDirectory()) rmdirSync(target);
      else unlinkSync(target);
    }
    return { path: input, deleted: items.length };
  }
  /** 读取并更新当前列表。 */
  list(input: string) {
    /** 当前操作使用的路径。 */
    const path = this.path(input);
    if (!lstatSync(path).isDirectory()) throw new ToolError('路径不是目录');
    /** 待处理条目列表。 */
    const items = entries(path, 201);
    return {
      entries: items.slice(0, 200).map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? 'blocked-link'
          : entry.isDirectory()
            ? 'directory'
            : entry.isFile()
              ? 'file'
              : 'other',
      })),
      truncated: items.length > 200,
    };
  }
  /** 按当前关键词执行检索。 */
  search(input: string, query: string, signal: AbortSignal) {
    /** 本次处理的起始位置或时间。 */
    const start = this.path(input);
    if (!lstatSync(start).isDirectory()) throw new ToolError('搜索范围必须是目录');
    /** 本次处理结果列表。 */
    const results: { path: string; line: number; text: string }[] = [];
    /** 等待遍历的相对目录或条目路径。 */
    const queue = [input];
    /** 已访问的目录项数量，用于限制遍历规模。 */
    let visited = 0;
    /** 已读取的字节数据或目录累计字节量。 */
    let bytes = 0;
    /** 本次等待允许持续到的截止时间。 */
    const deadline = Date.now() + 10000;
    while (queue.length && visited < 500 && results.length < 100 && bytes < 1048576) {
      /** 当前目录。 */
      const directory = queue.shift()!;
      for (/* 逐项处理当前目录或集合条目。 */ const entry of entries(
        this.path(directory),
        501 - visited,
      )) {
        signal.throwIfAborted();
        if (Date.now() > deadline) throw new ToolError('搜索达到时限');
        if (++visited > 500 || results.length >= 100 || bytes >= 1048576) break;
        if (entry.isSymbolicLink()) continue;
        /** 当前遍历条目相对工作区的路径。 */
        const name = directory === '.' ? entry.name : `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          queue.push(name);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          /** 当前处理的文本。 */
          const text = this.read(name);
          bytes += Buffer.byteLength(text);
          for (/* 逐项处理当前条目索引、当前文本行。 */ const [index, line] of text
            .split(/\r?\n/)
            .entries())
            if (line.includes(query) && results.length < 100)
              results.push({ path: name, line: index + 1, text: line.slice(0, 200) });
        } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
          if (!(error instanceof ToolError)) throw error;
        }
      }
    }
    return {
      results,
      truncated: queue.length > 0 || visited >= 500 || results.length >= 100 || bytes >= 1048576,
    };
  }
}
