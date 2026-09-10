import type { DatabaseSync } from 'node:sqlite';
import type { Memory, MemorySearch, TaskSearch, TaskEvidence } from '@mlclaw/shared';
import { ToolError } from '../tools/files.js';

export class RetrievalError extends ToolError { constructor(message: string, public statusCode = 400) { super(message); } }
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stopWords = new Set(['我', '的', '了', '是', '在', '和', '有', '吗', '请', '帮', '一下', '什么', '怎么', '如何', '我们', '你', 'the', 'a', 'an', 'is', 'of', 'to']);
export function keywords(query: string) {
  const text = query.trim().normalize('NFKC').toLowerCase();
  if (!text || text.length > 200) throw new RetrievalError('查询需包含 1–200 字符');
  const words = [...segmenter.segment(text)].filter(item => item.isWordLike && !stopWords.has(item.segment)).map(item => item.segment);
  return { query: text, terms: [...new Set(words)].slice(0, 8) };
}
function score(content: string, query: string, terms: string[]) {
  const text = content.normalize('NFKC').toLowerCase();
  return (text.includes(query) ? 20 : 0) + terms.filter(term => text.includes(term)).length * 2;
}
export function searchMemories(db: DatabaseSync, userId: string, query: string): MemorySearch {
  const parsed = keywords(query);
  const rows = db.prepare('SELECT id,content,priority,created_at,updated_at FROM memories WHERE user_id=? ORDER BY priority DESC,updated_at DESC,id LIMIT 100').all(userId);
  const matches = rows.map(row => ({ id: String(row.id), content: String(row.content), priority: Number(row.priority), created_at: String(row.created_at), updated_at: String(row.updated_at), score: score(String(row.content), parsed.query, parsed.terms) }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score || b.priority - a.priority || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  const items: Memory[] = [];
  for (const row of matches.slice(0, 10)) {
    const { score: _, ...item } = row;
    if (JSON.stringify([...items, item]).length > 10000) break;
    items.push(item);
  }
  const result = { query: parsed.query, terms: parsed.terms, items, truncated: items.length < matches.length };
  while (JSON.stringify(result).length > 10000 && result.items.length) { result.items.pop(); result.truncated = true; }
  return result;
}

const retrievalNames = "'search_memories','search_tasks','read_task','search_skills','read_skill','read_skill_resource'";
export function assertConversation(db: DatabaseSync, userId: string, conversationId: string) {
  if (!db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId)) throw new RetrievalError('会话不存在', 404);
}
export function searchTasks(db: DatabaseSync, userId: string, query: string, conversationId?: string): TaskSearch {
  const parsed = keywords(query);
  if (conversationId) assertConversation(db, userId, conversationId);
  // 参数作为普通文本匹配，不解释 LIKE 通配符、FTS 语法或正则表达式。
  const terms = parsed.terms.length ? parsed.terms : [parsed.query];
  const predicate = terms.map(() => `(instr(lower(t.input),?)>0 OR EXISTS (SELECT 1 FROM tool_calls c WHERE c.task_id=t.id AND c.name NOT IN (${retrievalNames}) AND (instr(lower(c.name),?)>0 OR instr(lower(COALESCE(c.result,'')),?)>0)))`).join(' OR ');
  const rows = db.prepare(`SELECT t.id,t.conversation_id,t.status,t.kind,t.created_at,t.finished_at,substr(t.input,1,400) AS input FROM tasks t
    WHERE t.user_id=? AND t.status NOT IN ('queued','running','waiting_approval') ${conversationId ? 'AND t.conversation_id=?' : ''}
    AND (${predicate}) ORDER BY t.rowid DESC LIMIT 11`).all(userId, ...(conversationId ? [conversationId] : []), ...terms.flatMap(term => [term, term, term]));
  const result: TaskSearch = { query: parsed.query, scope: conversationId ? 'current' : 'all', truncated: rows.length > 10,
    items: rows.slice(0, 10).map(row => ({ id: String(row.id), conversationId: String(row.conversation_id), status: String(row.status), kind: String(row.kind), input: String(row.input), createdAt: String(row.created_at), finishedAt: row.finished_at ? String(row.finished_at) : null })) };
  while (JSON.stringify(result).length > 14000 && result.items.length) { result.items.pop(); result.truncated = true; }
  return result;
}
export function readTask(db: DatabaseSync, userId: string, taskId: string, offset = 0): TaskEvidence {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw new RetrievalError('工具记录分页偏移无效');
  const task = db.prepare('SELECT id,conversation_id,status,kind,input,error,created_at,finished_at FROM tasks WHERE id=? AND user_id=?').get(taskId, userId);
  if (!task) throw new RetrievalError('任务不存在', 404);
  if (['queued', 'running', 'waiting_approval'].includes(String(task.status))) throw new RetrievalError('任务尚未结束，请结束后再查询历史证据', 409);
  const rows = db.prepare(`SELECT id,name,status,substr(result,1,600) AS result,length(result) AS size,created_at,finished_at FROM tool_calls
    WHERE task_id=? ORDER BY rowid LIMIT 11 OFFSET ?`).all(taskId, offset);
  const tools = rows.slice(0, 10).map(row => {
    const omitted = ['search_memories', 'search_tasks', 'read_task', 'search_skills', 'read_skill', 'read_skill_resource'].includes(String(row.name));
    return { id: String(row.id), name: String(row.name), status: String(row.status), result: omitted ? '历史检索结果不回放，请重新查询当前数据。' : row.result === null ? null : String(row.result),
      truncated: !omitted && Number(row.size) > 600, createdAt: String(row.created_at), finishedAt: row.finished_at ? String(row.finished_at) : null };
  });
  // 将大结果按页返回；不提供配置快照、工具参数、批准决定或摘要。
  const result: TaskEvidence = { id: String(task.id), conversationId: String(task.conversation_id), status: String(task.status), kind: String(task.kind),
    input: String(task.input).slice(0, 800), error: task.error ? String(task.error).slice(0, 500) : null,
    createdAt: String(task.created_at), finishedAt: task.finished_at ? String(task.finished_at) : null, tools,
    nextOffset: rows.length > 10 ? offset + 10 : null, referenceOnly: true };
  while (JSON.stringify(result).length > 14000 && result.tools.length) { result.tools.pop(); result.nextOffset = offset + result.tools.length; }
  return result;
}
export class RetrievalSession {
  constructor(private db: DatabaseSync, private userId: string, private conversationId?: string) {}
  memories(query: string) { return searchMemories(this.db, this.userId, query); }
  tasks(query: string, scope: string) {
    if (scope !== 'all' && !this.conversationId) throw new RetrievalError('未指定当前会话');
    return searchTasks(this.db, this.userId, query, scope === 'all' ? undefined : this.conversationId);
  }
  read(id: string, offset: number) { return readTask(this.db, this.userId, id, offset); }
}
