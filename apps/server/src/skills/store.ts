import { createHash } from 'node:crypto';
import { lstatSync, opendirSync } from 'node:fs';
import { parseDocument } from 'yaml';
import type { Skill, SkillDetail, SkillDirectory, SkillSearch } from '@mlclaw/shared';
import { record } from '../providers/types.js';
import { RetrievalError, keywords } from '../retrieval/search.js';
import { Workspace, ToolError } from '../tools/files.js';
import { formatSystemTime } from '../time.js';

export class SkillError extends RetrievalError {}
/** 文件内容版本用于显示、任务校验和读取记录，不代表递增序号。 */
export const skillVersion = (content: string) => createHash('sha256').update(content).digest('hex');
/** 只公开可定位的业务错误，不回传操作系统的绝对路径。 */
const message = (error: unknown) =>
  error instanceof ToolError ? error.message : '文件不可读取，请检查文件权限与格式';
/** 有界遍历目录，避免对大量目录项进行无界分配。 */
const entries = (path: string, limit: number) => {
  const directory = opendirSync(path);
  const items = [];
  try {
    while (items.length <= limit) {
      const item = directory.readSync();
      if (!item) break;
      items.push(item);
    }
    return items;
  } finally {
    directory.closeSync();
  }
};

/** 读取标准 SKILL.md；扩展字段保留在正文里，不会注册工具或执行安装。 */
export const parseSkill = (
  source: string,
): { name: string; description: string; enabled: boolean } => {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new SkillError('SKILL.md 需要以 YAML 元信息开头，并使用 --- 分隔');
  let data: unknown;
  try {
    const document = parseDocument(match[1]!, { schema: 'core', uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    data = document.toJS({ maxAliasCount: 20 });
  } catch {
    throw new SkillError('SKILL.md 的 YAML 元信息无效');
  }
  if (!record(data)) throw new SkillError('技能元信息必须是对象');
  if (
    typeof data.name !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) ||
    data.name.length > 64
  )
    throw new SkillError('name 需为 1–64 字符的小写英文、数字或中划线');
  if (
    typeof data.description !== 'string' ||
    !data.description.trim() ||
    data.description.length > 4096
  )
    throw new SkillError('description 需为 1–4096 字符的适用场景说明');
  if (data.enabled !== undefined && typeof data.enabled !== 'boolean')
    throw new SkillError('可选 enabled 字段必须为布尔值');
  return { name: data.name, description: data.description.trim(), enabled: data.enabled !== false };
};

/** 技能目录与普通文件工具共用工作区和链接边界。 */
export class SkillStore {
  readonly directory = 'skills';
  constructor(readonly workspace: Workspace) {}

  /** ID 就是一级技能目录名，不能构造多级路径。 */
  private base(id: string) {
    if (!id || id.includes('/') || id.includes('\\') || id.startsWith('.'))
      throw new SkillError('技能目录名称无效');
    const basePath = `${this.directory}/${id}`;
    if (!lstatSync(this.workspace.path(basePath)).isDirectory())
      throw new SkillError('技能目录不存在');
    return basePath;
  }

  /** 按需读取完整入口，名称无需与目录名相同，重复名称通过路径区分。 */
  read(id: string): Skill & { content: string } {
    try {
      const basePath = this.base(id);
      const location = `${basePath}/SKILL.md`;
      const content = this.workspace.read(location);
      const metadata = parseSkill(content);
      return {
        id,
        ...metadata,
        basePath,
        location,
        version: skillVersion(content),
        updatedAt: formatSystemTime(lstatSync(this.workspace.path(location)).mtime),
        content,
      };
    } catch (error) {
      throw new SkillError(message(error), 404);
    }
  }

  /** 每次请求或新任务扫描；正文只用于解析，目录和任务快照只保留元信息。 */
  scan(): SkillDirectory {
    const result: SkillDirectory = { directory: this.directory, skills: [], issues: [] };
    try {
      const root = this.workspace.path(this.directory, true);
      let stat;
      try {
        stat = lstatSync(root);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return result;
        throw error;
      }
      if (!stat.isDirectory()) throw new SkillError('skills 必须是目录');
      const folders = entries(this.workspace.path(this.directory), 500);
      if (folders.length > 500)
        result.issues.push({ path: this.directory, message: '目录超过 500 项，只扫描前 500 项' });
      for (const folder of folders.slice(0, 500).sort((a, b) => a.name.localeCompare(b.name))) {
        if (folder.name.startsWith('.')) continue;
        const location = `${this.directory}/${folder.name}/SKILL.md`;
        if (folder.isSymbolicLink()) {
          result.issues.push({ path: location, message: '技能目录不接受符号链接或目录联接' });
          continue;
        }
        if (!folder.isDirectory()) continue;
        try {
          const { content: _content, ...skill } = this.read(folder.name);
          result.skills.push(skill);
        } catch (error) {
          result.issues.push({ path: location, message: message(error) });
        }
      }
    } catch (error) {
      result.issues.push({ path: this.directory, message: message(error) });
    }
    return result;
  }

  /** 列出资源路径但不读取内容，二进制模板也保留原样。 */
  detail(id: string): SkillDetail {
    try {
      const skill = this.read(id);
      const queue = [skill.basePath];
      const resources: string[] = [];
      let visited = 0;
      let resourcesTruncated = false;
      while (queue.length && !resourcesTruncated) {
        const directory = queue.shift()!;
        for (const entry of entries(this.workspace.path(directory), 1000 - visited)) {
          if (++visited > 1000) {
            resourcesTruncated = true;
            break;
          }
          const path = `${directory}/${entry.name}`;
          this.workspace.path(path);
          if (entry.isDirectory()) queue.push(path);
          else if (entry.isFile() && path !== skill.location)
            resources.push(path.slice(skill.basePath.length + 1));
        }
      }
      return { ...skill, resources: resources.sort(), resourcesTruncated };
    } catch (error) {
      if (error instanceof SkillError) throw error;
      throw new SkillError(message(error));
    }
  }

  /** 资源必须位于技能包内；路径逐段校验，读取时重新检查链接和字节上限。 */
  resource(id: string, name: string) {
    try {
      const basePath = this.base(id);
      const path = `${basePath}/${name.replace(/^\.\//, '')}`;
      const content = this.workspace.read(path);
      return { path, content, version: skillVersion(content) };
    } catch (error) {
      throw new SkillError(message(error));
    }
  }

  /** 搜索当前可用技能的名称、描述和入口正文，不预读所有配套资源。 */
  search(query: string): SkillSearch {
    const parsed = keywords(query);
    const terms = parsed.terms.length ? parsed.terms : [parsed.query];
    const matches = this.scan()
      .skills.filter((skill) => skill.enabled)
      .flatMap((skill) => {
        let content;
        try {
          content = this.read(skill.id).content;
        } catch {
          return [];
        }
        const fields = [
          { source: '名称/描述', text: `${skill.name}\n${skill.description}`, weight: 3 },
          { source: 'SKILL.md', text: content, weight: 1 },
        ]
          .map((field) => {
            const text = field.text.normalize('NFKC').toLowerCase();
            return {
              ...field,
              text,
              score:
                field.weight *
                ((text.includes(parsed.query) ? 20 : 0) +
                  terms.filter((term) => text.includes(term)).length * 2),
            };
          })
          .sort((a, b) => b.score - a.score);
        const best = fields[0]!;
        if (!best.score) return [];
        const positions = [parsed.query, ...terms]
          .map((term) => best.text.indexOf(term))
          .filter((index) => index >= 0);
        const start = Math.max(0, Math.min(...positions) - 60);
        return [
          {
            id: skill.id,
            name: skill.name,
            description: skill.description.slice(0, 300),
            version: skill.version,
            score: fields.reduce((sum, field) => sum + field.score, 0),
            source: best.source,
            excerpt: best.text.slice(start, start + 350),
          },
        ];
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { query: parsed.query, items: matches.slice(0, 5), truncated: matches.length > 5 };
  }
}

/** 初始目录只包含可发现的元信息，超长时精简描述并明确提示搜索剩余技能。 */
export const skillsCatalog = (skills: Skill[]): string => {
  const eligible = skills.filter((skill) => skill.enabled);
  if (!eligible.length) return '';
  const items = eligible.map(({ id, name, description, location }) => ({
    id,
    name,
    description: description.slice(0, 300),
    location,
  }));
  let shortened = eligible.some((skill) => skill.description.length > 300);
  while (JSON.stringify(items).length > 9000) {
    const longest = items.reduce((a, b) => (a.description.length > b.description.length ? a : b));
    if (longest.description.length)
      longest.description = longest.description.slice(
        0,
        Math.floor(longest.description.length / 2),
      );
    else items.pop();
    shortened = true;
  }
  return JSON.stringify({ skills: items, shortened, omitted: eligible.length - items.length });
};
