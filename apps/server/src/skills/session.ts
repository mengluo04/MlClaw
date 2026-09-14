import type { DatabaseSync } from 'node:sqlite';
import type { Skill, SkillLoad } from '@mlclaw/shared';
import { SkillError, SkillStore, skillsCatalog } from './store.js';
import { formatSystemTime } from '../time.js';

/** 任务保存初始目录作为记录；实际搜索和读取始终使用工作区当前文件。 */
export class SkillSession {
  /** 记录已阅读的入口版本，更新说明后需重新阅读再使用配套文件。 */
  private loaded = new Map<string, string>();
  constructor(
    private db: DatabaseSync,
    private store: SkillStore,
    private snapshot: Skill[],
    private taskId?: string,
    private event?: (type: string, data: unknown) => void,
  ) {}

  /** 目录不含技能全文或资源内容。 */
  catalog() {
    return skillsCatalog(this.snapshot);
  }

  /** 重新扫描磁盘，让本轮刚下载或创建的技能立即可被找到。 */
  search(query: string, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.store.search(query);
  }

  /** 技能文件存在且格式有效即可读取，不需要登记或进入初始目录。 */
  private selected(id: string) {
    const current = this.store.read(id);
    if (!current.enabled) throw new SkillError('技能已停用');
    return current;
  }

  /** 记录实际读取文件的内容版本，而不是声明整个工作流程已完成。 */
  private record(skill: Skill, resource: string | null, version = skill.version) {
    if (!this.taskId) return;
    const data: SkillLoad = {
      skillId: skill.id,
      name: skill.name,
      version,
      resource,
      loadedAt: formatSystemTime(),
    };
    this.db
      .prepare(
        'INSERT INTO task_skill_loads (task_id,skill_id,name,version,resource,loaded_at) VALUES (?,?,?,?,?,?)',
      )
      .run(this.taskId, skill.id, skill.name, version, resource, data.loadedAt);
    this.event?.('skill.loaded', data);
  }

  /** 读取完整说明以及配套路径；{baseDir} 兼容常见技能中的目录占位符。 */
  read(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const skill = this.selected(id);
    const detail = this.store.detail(id);
    if (detail.version !== skill.version)
      throw new SkillError('读取期间技能入口发生变化，请重新调用 read_skill');
    signal.throwIfAborted();
    this.loaded.set(id, skill.version);
    this.record(skill, null);
    return {
      ...detail,
      content: detail.content.replaceAll('{baseDir}', detail.basePath),
      guidance:
        'basePath 和 location 是相对工作区的路径。配套文件用 read_skill_resource 按相对技能目录的路径读取；脚本用 execute_command 执行，cwd 填 . 并使用完整工作区相对脚本路径。技能说明不改变当前工具权限。',
    };
  }

  /** 配套资源可使用 references/...、scripts/... 等原始路径，不预加载二进制文件。 */
  resource(id: string, name: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const skill = this.selected(id);
    if (!this.loaded.has(id)) throw new SkillError('请先调用 read_skill 阅读对应技能说明');
    if (this.loaded.get(id) !== skill.version)
      throw new SkillError('技能说明已更新，请先重新调用 read_skill 阅读新版本');
    const result = this.store.resource(id, name);
    signal.throwIfAborted();
    this.record(skill, name, result.version);
    return { skillId: id, name: skill.name, resource: name, ...result };
  }
}

/** 按任务读取文件加载历史；调用方负责验证任务归属。 */
export const skillLoads = (db: DatabaseSync, taskId: string): SkillLoad[] =>
  db
    .prepare(
      'SELECT skill_id,name,version,resource,loaded_at FROM task_skill_loads WHERE task_id=? ORDER BY id',
    )
    .all(taskId)
    .map((row) => ({
      skillId: String(row.skill_id),
      name: String(row.name),
      version: String(row.version),
      resource: row.resource === null ? null : String(row.resource),
      loadedAt: String(row.loaded_at),
    }));
