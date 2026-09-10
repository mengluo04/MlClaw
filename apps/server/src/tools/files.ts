import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, writeSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export class ToolError extends Error {}
function boundedRead(fd: number, limit: number): Buffer {
  const buffer = Buffer.alloc(limit + 1); let used = 0;
  while (used <= limit) { const n = readSync(fd, buffer, used, buffer.length - used, used); if (!n) break; used += n; }
  if (used > limit) throw new ToolError('文件超过大小限制');
  return buffer.subarray(0, used);
}
function entries(path: string, limit: number): Dirent[] {
  const directory = opendirSync(path); const result: Dirent[] = [];
  try { while (result.length < limit) { const item = directory.readSync(); if (!item) break; result.push(item); } return result; }
  finally { directory.closeSync(); }
}
export class Workspace {
  readonly root: string;
  readonly maxFileBytes = 65536;
  constructor(root: string) {
    mkdirSync(root, { recursive: true }); this.root = realpathSync(root);
  }
  path(input: string, allowMissing = false): string {
    if (input.length > 500 || /[\x00-\x1f<>:"|?*]/.test(input) || isAbsolute(input) || input.includes('\\')) throw new ToolError('路径格式无效，请使用工作目录内的相对路径和正斜线');
    const parts = input === '.' ? [] : input.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new ToolError('路径包含不允许的目录或文件名');
    let current = this.root;
    if (realpathSync(this.root) !== this.root || lstatSync(this.root).isSymbolicLink()) throw new ToolError('工作目录已改变');
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      if (!existsSync(current)) {
        // existsSync 对悬空链接返回 false，lstat 仍需显式检查。
        try { lstatSync(current); throw new ToolError('不允许符号链接'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        if (allowMissing && index === parts.length - 1) return current;
        throw new ToolError('路径不存在；请先使用已存在的父目录');
      }
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new ToolError('不允许符号链接、目录联接或硬链接');
      const resolved = realpathSync(current); const inside = relative(this.root, resolved);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new ToolError('路径超出授权工作目录');
      if (index < parts.length - 1 && !stat.isDirectory()) throw new ToolError('父路径不是目录');
    }
    return current;
  }
  readBytes(input: string, limit = this.maxFileBytes): Buffer {
    const path = this.path(input); const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit) throw new ToolError('只能读取大小符合限制的普通文件');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink > 1 || opened.size > limit || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new ToolError('文件已变化或超出限制');
      return boundedRead(fd, limit);
    } finally { closeSync(fd); }
  }
  read(input: string) {
    const bytes = this.readBytes(input);
    try { const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (content.includes('\0')) throw new Error(); return content; }
    catch { throw new ToolError('文件不是有效 UTF-8 文本'); }
  }
  snapshot(input: string): string {
    const path = this.path(input, true);
    if (!existsSync(path)) return 'absent';
    return createHash('sha256').update(this.readBytes(input)).digest('hex');
  }
  write(input: string, content: string, snapshot: string, signal: AbortSignal) {
    return this.writeBytes(input, Buffer.from(content), snapshot, signal);
  }
  usage() {
    const queue = ['.']; let files = 0; let bytes = 0; let visited = 0;
    while (queue.length) {
      const directory = queue.shift()!;
      for (const entry of entries(this.path(directory), 5001 - visited)) {
        if (++visited > 5000) throw new ToolError('工作目录条目超过配额扫描上限');
        const name = directory === '.' ? entry.name : `${directory}/${entry.name}`;
        // 链接不会被跟随，也不能借它绕过写入边界。
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) queue.push(name);
        else if (entry.isFile()) { files++; bytes += lstatSync(join(this.root, name)).size; }
        else throw new ToolError('工作目录存在不支持的特殊文件');
      }
    }
    return { files, bytes };
  }
  writeBytes(input: string, bytes: Buffer, snapshot: string, signal: AbortSignal) {
    if (bytes.length > this.maxFileBytes) throw new ToolError('写入内容超过 64 KiB');
    const path = this.path(input, true); signal.throwIfAborted();
    if (this.snapshot(input) !== snapshot) throw new ToolError('文件状态已变化，请重新发起调用并授权');
    const usage = this.usage(); const previousSize = snapshot === 'absent' ? 0 : lstatSync(path).size;
    if (usage.bytes - previousSize + bytes.length > 20 * 1024 * 1024 || usage.files + (snapshot === 'absent' ? 1 : 0) > 500) throw new ToolError('工作目录超过 20 MiB 或 500 文件配额');
    // 校验至写入之间不让出事件循环；创建采用排他模式，覆盖在已校验的句柄上进行。
    const fd = openSync(path, snapshot === 'absent' ? 'wx' : constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink > 1) throw new ToolError('目标不是独立普通文件');
      if (snapshot !== 'absent' && createHash('sha256').update(boundedRead(fd, this.maxFileBytes)).digest('hex') !== snapshot) throw new ToolError('文件已改变，原授权失效');
      signal.throwIfAborted();
      let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
      ftruncateSync(fd, bytes.length); fsyncSync(fd);
    } finally { closeSync(fd); }
    return { path: input, bytes: bytes.length };
  }
  list(input: string) {
    const path = this.path(input); if (!lstatSync(path).isDirectory()) throw new ToolError('路径不是目录');
    const items = entries(path, 201);
    return { entries: items.slice(0, 200).map(entry => ({ name: entry.name, type: entry.isSymbolicLink() ? 'blocked-link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), truncated: items.length > 200 };
  }
  search(input: string, query: string, signal: AbortSignal) {
    const start = this.path(input); if (!lstatSync(start).isDirectory()) throw new ToolError('搜索范围必须是目录');
    const results: { path: string; line: number; text: string }[] = [];
    const queue = [input]; let visited = 0; let bytes = 0; const deadline = Date.now() + 10000;
    while (queue.length && visited < 500 && results.length < 100 && bytes < 1048576) {
      const directory = queue.shift()!;
      for (const entry of entries(this.path(directory), 501 - visited)) {
        signal.throwIfAborted(); if (Date.now() > deadline) throw new ToolError('搜索达到时限');
        if (++visited > 500 || results.length >= 100 || bytes >= 1048576) break;
        if (entry.isSymbolicLink()) continue;
        const name = directory === '.' ? entry.name : `${directory}/${entry.name}`;
        if (entry.isDirectory()) { queue.push(name); continue; }
        if (!entry.isFile()) continue;
        try {
          const text = this.read(name); bytes += Buffer.byteLength(text);
          for (const [index, line] of text.split(/\r?\n/).entries()) if (line.includes(query) && results.length < 100) results.push({ path: name, line: index + 1, text: line.slice(0, 200) });
        } catch (error) { if (!(error instanceof ToolError)) throw error; }
      }
    }
    return { results, truncated: queue.length > 0 || visited >= 500 || results.length >= 100 || bytes >= 1048576 };
  }
}
