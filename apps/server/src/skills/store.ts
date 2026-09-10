import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Skill, SkillInput, SkillSearch } from '@mlclaw/shared';
import { record } from '../providers/types.js';
import { RetrievalError, keywords } from '../retrieval/search.js';
import { transaction } from '../db/index.js';
import { formatSystemTime } from '../time.js';

export class SkillError extends RetrievalError {}
function string(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new SkillError(`${label}需包含 1–${max} 字符`);
  return value.trim();
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new SkillError('技能版本无效');
  return Number(value);
}
export function parseSkill(value: unknown): SkillInput {
  if (!record(value) || Object.keys(value).some(key => !['name','description','keywords','content','enabled','resources'].includes(key))) throw new SkillError('技能参数无效');
  const name = string(value.name, '技能名称', 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new SkillError('技能名称只使用小写英文、数字和中划线');
  const description = string(value.description, '技能描述', 300);
  const content = string(value.content, '技能正文', 8000);
  if (JSON.stringify(content).length > 9000) throw new SkillError('技能正文序列化后超过 9000 字符');
  if (typeof value.enabled !== 'boolean') throw new SkillError('技能启用状态无效');
  if (!Array.isArray(value.keywords) || value.keywords.length > 10) throw new SkillError('技能关键词最多 10 个');
  const terms = [...new Set(value.keywords.map(item => string(item, '关键词', 30)))];
  if (!Array.isArray(value.resources) || value.resources.length > 5) throw new SkillError('参考文档最多 5 份');
  const resources = value.resources.map(item => {
    if (!record(item) || Object.keys(item).some(key => !['name','content'].includes(key))) throw new SkillError('参考文档格式无效');
    const name = string(item.name, '文档名称', 64);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || name.includes('..')) throw new SkillError('文档名称只使用英文、数字、中划线、下划线和扩展名，不接受路径');
    const content = string(item.content, '参考文档正文', 4000);
    if (JSON.stringify(content).length > 6000) throw new SkillError('参考文档序列化后超过 6000 字符');
    return { name, content };
  });
  if (new Set(resources.map(item => item.name.toLowerCase())).size !== resources.length) throw new SkillError('参考文档名称不能重复');
  const result = { name, description, content, enabled: value.enabled, keywords: terms, resources };
  if (JSON.stringify(result).length > 32000) throw new SkillError('单个技能总容量超过 32000 字符');
  return result;
}
export function listSkills(db: DatabaseSync, userId: string): Skill[] {
  return db.prepare('SELECT * FROM skills WHERE user_id=? ORDER BY name LIMIT 30').all(userId).map(row => ({
    ...parseSkill(JSON.parse(String(row.document))), id: String(row.id), version: Number(row.version), accessVersion: Number(row.access_version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }));
}
export function getSkill(db: DatabaseSync, userId: string, id: string): Skill {
  const skill = listSkills(db, userId).find(item => item.id === id);
  if (!skill) throw new SkillError('技能不存在', 404);
  return skill;
}
export function saveSkill(db: DatabaseSync, userId: string, input: SkillInput, id?: string, expectedVersion?: number): Skill {
  const value = parseSkill(input);
  return transaction(db, () => {
    const all = listSkills(db, userId); const current = id ? getSkill(db, userId, id) : undefined;
    if (current && current.version !== expectedVersion) throw new SkillError('技能已被其他页面更新，请重新加载后重试', 409);
    if (!current && all.length >= 30) throw new SkillError('最多保存 30 个技能');
    if (all.some(item => item.name === value.name && item.id !== id)) throw new SkillError('技能名称已存在', 409);
    const document = JSON.stringify(value);
    if (all.filter(item => item.id !== id).reduce((n, item) => n + JSON.stringify(item).length, document.length) > 160000) throw new SkillError('技能总容量超过 160000 字符，请精简正文和参考文档');
    const now = formatSystemTime(); const key = id ?? randomUUID();
    if (current) db.prepare('UPDATE skills SET name=?,document=?,version=version+1,access_version=?,enabled=?,updated_at=? WHERE id=? AND user_id=?').run(value.name, document, current.accessVersion + Number(current.enabled !== value.enabled), Number(value.enabled), now, key, userId);
    else db.prepare('INSERT INTO skills VALUES (?,?,?,?,1,1,?,?,?)').run(key, userId, value.name, document, Number(value.enabled), now, now);
    return getSkill(db, userId, key);
  });
}
export function deleteSkill(db: DatabaseSync, userId: string, id: string, expectedVersion: number) {
  if (getSkill(db, userId, id).version !== expectedVersion) throw new SkillError('技能已被其他页面更新，请重新加载后重试', 409);
  db.prepare('DELETE FROM skills WHERE id=? AND user_id=?').run(id, userId);
}
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
export function searchSkills(skills: Skill[], query: string): SkillSearch {
  const parsed = keywords(query); const terms = parsed.terms.length ? parsed.terms : [parsed.query];
  const matches = skills.filter(skill => skill.enabled).flatMap(skill => {
    const fields = [{ source: '名称/描述/关键词', text: `${skill.name}\n${skill.description}\n${skill.keywords.join(' ')}`, weight: 3 },
      { source: '正文', text: skill.content, weight: 1 }, ...skill.resources.map(item => ({ source: item.name, text: item.content, weight: 1 }))];
    const scored = fields.map(field => { const text = normalize(field.text); return { ...field, text, score: field.weight * ((text.includes(parsed.query) ? 20 : 0) + terms.filter(term => text.includes(term)).length * 2) }; }).sort((a,b) => b.score-a.score);
    const best = scored[0]!; if (!best.score) return [];
    const positions = [parsed.query,...terms].map(term => best.text.indexOf(term)).filter(index => index >= 0);
    const start = Math.max(0, Math.min(...positions) - 60);
    return [{ id: skill.id, name: skill.name, description: skill.description, version: skill.version, score: scored.reduce((n,item)=>n+item.score,0), source: best.source, excerpt: best.text.slice(start,start+350) }];
  }).sort((a,b) => b.score-a.score || a.name.localeCompare(b.name));
  const result = { query: parsed.query, items: matches.slice(0,5), truncated: matches.length>5 };
  while (JSON.stringify(result).length>6000 && result.items.length) { result.items.pop(); result.truncated=true; }
  return result;
}
export function skillsCatalog(skills: Skill[]): string {
  const items = skills.filter(item=>item.enabled).map(item=>({ id:item.id, name:item.name, version:item.version, description:item.description, keywords:[...item.keywords] }));
  if (!items.length) return '';
  let shortened = false;
  while (JSON.stringify(items).length>9000) {
    const longest = items.reduce((a,b)=>a.description.length+JSON.stringify(a.keywords).length > b.description.length+JSON.stringify(b.keywords).length ? a:b);
    if (longest.keywords.length) longest.keywords.pop(); else longest.description=longest.description.slice(0,Math.floor(longest.description.length/2));
    shortened=true;
  }
  return JSON.stringify({ skills:items, shortened });
}
