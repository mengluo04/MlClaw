import type { DatabaseSync } from 'node:sqlite';
import type { Skill, SkillLoad } from '@mlclaw/shared';
import { SkillError, searchSkills, skillsCatalog } from './store.js';
import { formatSystemTime } from '../time.js';

export class SkillSession {
  private calls = 0;
  private output = 0;
  private loaded = new Set<string>();
  constructor(private db: DatabaseSync, private userId: string, private snapshot: Skill[], private taskId?: string, private event?: (type: string, data: unknown) => void) {}
  private eligible(skill: Skill) {
    const current = this.db.prepare('SELECT enabled,access_version FROM skills WHERE id=? AND user_id=?').get(skill.id,this.userId);
    return skill.enabled && !!current?.enabled && Number(current.access_version) === skill.accessVersion;
  }
  catalog() { return skillsCatalog(this.snapshot.filter(item=>this.eligible(item))); }
  private begin(signal: AbortSignal) {
    signal.throwIfAborted();
    if (++this.calls>12) throw new SkillError('本任务技能查询/读取达到 12 次上限');
  }
  private take<T>(value: T, signal: AbortSignal): T {
    signal.throwIfAborted();
    const size=JSON.stringify(value).length;
    if (size>12000 || this.output+size>24000) throw new SkillError('本任务技能输出达到容量上限，请缩小范围或新建任务');
    this.output+=size; return value;
  }
  search(query: string, signal: AbortSignal) {
    this.begin(signal);
    return this.take(searchSkills(this.snapshot.filter(item=>this.eligible(item)),query),signal);
  }
  private selected(id: string): Skill {
    const skill=this.snapshot.find(item=>item.id===id);
    if (!skill || !this.eligible(skill)) throw new SkillError('技能不在本任务可用范围，或已被禁用/删除');
    return skill;
  }
  private record(skill: Skill, resource: string | null) {
    if (!this.taskId) return;
    const data: SkillLoad = { skillId:skill.id,name:skill.name,version:skill.version,resource,loadedAt:formatSystemTime() };
    this.db.prepare('INSERT INTO task_skill_loads (task_id,skill_id,name,version,resource,loaded_at) VALUES (?,?,?,?,?,?)').run(this.taskId,skill.id,skill.name,skill.version,resource,data.loadedAt);
    this.event?.('skill.loaded',data);
  }
  read(id: string, signal: AbortSignal) {
    this.begin(signal); const skill=this.selected(id);
    if (!this.loaded.has(id) && this.loaded.size>=3) throw new SkillError('本任务最多加载 3 个不同技能');
    const result=this.take({ id:skill.id,name:skill.name,version:skill.version,description:skill.description,content:skill.content,
      resources:skill.resources.map(item=>({ name:item.name })), guidanceOnly:true },signal);
    this.loaded.add(id); this.record(skill,null); return result;
  }
  resource(id: string, name: string, signal: AbortSignal) {
    this.begin(signal); const skill=this.selected(id);
    if (!this.loaded.has(id)) throw new SkillError('请先调用 read_skill 阅读对应技能说明');
    const resource=skill.resources.find(item=>item.name===name);
    if (!resource) throw new SkillError('技能参考文档不存在');
    const result=this.take({ skillId:id,name:skill.name,version:skill.version,resource:name,content:resource.content,guidanceOnly:true },signal);
    this.record(skill,name); return result;
  }
}
export function skillLoads(db: DatabaseSync, taskId: string): SkillLoad[] {
  return db.prepare('SELECT skill_id,name,version,resource,loaded_at FROM task_skill_loads WHERE task_id=? ORDER BY id LIMIT 12').all(taskId).map(row=>({
    skillId:String(row.skill_id),name:String(row.name),version:Number(row.version),resource:row.resource===null?null:String(row.resource),loadedAt:String(row.loaded_at),
  }));
}
