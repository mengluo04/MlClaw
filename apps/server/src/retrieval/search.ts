import type { DatabaseSync } from 'node:sqlite';
import type { Memory, MemorySearch, TaskSearch, TaskEvidence } from '@mlclaw/shared';
import { ToolError } from '../tools/files.js';

export class RetrievalError extends ToolError {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
/** 支持中文词边界的分词器。 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
/** 检索时忽略的常见停用词。 */
const stopWords = new Set([
  '我',
  '的',
  '了',
  '是',
  '在',
  '和',
  '有',
  '吗',
  '请',
  '帮',
  '一下',
  '什么',
  '怎么',
  '如何',
  '我们',
  '你',
  'the',
  'a',
  'an',
  'is',
  'of',
  'to',
]);
/** 将查询文本拆分为检索关键词。 */
export const keywords = (query: string) => {
  /** 当前处理的文本。 */
  const text = query.trim().normalize('NFKC').toLowerCase();
  if (!text || text.length > 200) throw new RetrievalError('查询需包含 1–200 字符');
  /** 解析得到的词项列表。 */
  const words = [...segmenter.segment(text)]
    .filter((item) => item.isWordLike && !stopWords.has(item.segment))
    .map((item) => item.segment);
  return { query: text, terms: [...new Set(words)].slice(0, 8) };
};
/** 计算当前条目与检索条件的相关度。 */
const score = (content: string, query: string, terms: string[]) => {
  /** 当前处理的文本。 */
  const text = content.normalize('NFKC').toLowerCase();
  return (text.includes(query) ? 20 : 0) + terms.filter((term) => text.includes(term)).length * 2;
};
/** 在当前用户记忆中检索相关条目。 */
export const searchMemories = (db: DatabaseSync, userId: string, query: string): MemorySearch => {
  /** 解析后的结构化数据。 */
  const parsed = keywords(query);
  /** memories 表的查询记录集合。 */
  const rows = db
    .prepare(
      'SELECT id,content,priority,created_at,updated_at FROM memories WHERE user_id=? ORDER BY priority DESC,updated_at DESC,id LIMIT 100',
    )
    .all(userId);
  /** 当前匹配结果集合。 */
  const matches = rows
    .map((row) => ({
      id: String(row.id),
      content: String(row.content),
      priority: Number(row.priority),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      score: score(String(row.content), parsed.query, parsed.terms),
    }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.priority - a.priority ||
        b.updated_at.localeCompare(a.updated_at) ||
        a.id.localeCompare(b.id),
    );
  /** 待处理条目列表。 */
  const items: Memory[] = [];
  for (/* 逐项处理当前数据库记录。 */ const row of matches.slice(0, 10)) {
    /** 解构时剔除不应对外返回的内部字段。 */
    const { score: _, ...item } = row;
    if (JSON.stringify([...items, item]).length > 10000) break;
    items.push(item);
  }
  /** 本次处理结果。 */
  const result = {
    query: parsed.query,
    terms: parsed.terms,
    items,
    truncated: items.length < matches.length,
  };
  while (JSON.stringify(result).length > 10000 && result.items.length) {
    result.items.pop();
    result.truncated = true;
  }
  return result;
};

/** 检索工具名称集合，用于过滤递归检索证据。 */
const retrievalNames =
  "'search_memories','search_tasks','read_task','search_skills','read_skill','read_skill_resource'";
/** 验证会话存在且属于当前用户。 */
export const assertConversation = (db: DatabaseSync, userId: string, conversationId: string) => {
  if (
    !db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId)
  )
    throw new RetrievalError('会话不存在', 404);
};
/** 按归属检索历史任务与工具证据。 */
export const searchTasks = (
  db: DatabaseSync,
  userId: string,
  query: string,
  conversationId?: string,
): TaskSearch => {
  /** 解析后的结构化数据。 */
  const parsed = keywords(query);
  if (conversationId) assertConversation(db, userId, conversationId);
  // 参数作为普通文本匹配，不解释 LIKE 通配符、FTS 语法或正则表达式。
  const terms = parsed.terms.length ? parsed.terms : [parsed.query];
  /** 限定查询范围的 SQL 条件。 */
  const predicate = terms
    .map(
      () =>
        `(instr(lower(t.input),?)>0 OR EXISTS (SELECT 1 FROM tool_calls c WHERE c.task_id=t.id AND c.name NOT IN (${retrievalNames}) AND (instr(lower(c.name),?)>0 OR instr(lower(COALESCE(c.result,'')),?)>0)))`,
    )
    .join(' OR ');
  /** tasks 表的查询记录集合。 */
  const rows = db
    .prepare(
      `SELECT t.id,t.conversation_id,t.status,t.kind,t.created_at,t.finished_at,substr(t.input,1,400) AS input FROM tasks t
    WHERE t.user_id=? AND t.status NOT IN ('queued','running','waiting_approval') ${conversationId ? 'AND t.conversation_id=?' : ''}
    AND (${predicate}) ORDER BY t.rowid DESC LIMIT 11`,
    )
    .all(
      userId,
      ...(conversationId ? [conversationId] : []),
      ...terms.flatMap((term) => [term, term, term]),
    );
  /** 本次处理结果。 */
  const result: TaskSearch = {
    query: parsed.query,
    scope: conversationId ? 'current' : 'all',
    truncated: rows.length > 10,
    items: rows.slice(0, 10).map((row) => ({
      id: String(row.id),
      conversationId: String(row.conversation_id),
      status: String(row.status),
      kind: String(row.kind),
      input: String(row.input),
      createdAt: String(row.created_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
    })),
  };
  while (JSON.stringify(result).length > 14000 && result.items.length) {
    result.items.pop();
    result.truncated = true;
  }
  return result;
};
/** 校验归属后读取任务及关联记录。 */
export const readTask = (
  db: DatabaseSync,
  userId: string,
  taskId: string,
  offset = 0,
  conversationId?: string,
): TaskEvidence => {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000)
    throw new RetrievalError('工具记录分页偏移无效');
  /** 当前任务记录。 */
  const task = db
    .prepare(
      `SELECT id,conversation_id,status,kind,input,error,created_at,finished_at FROM tasks WHERE id=? AND user_id=?${conversationId ? ' AND conversation_id=?' : ''}`,
    )
    .get(taskId, userId, ...(conversationId ? [conversationId] : []));
  if (!task) throw new RetrievalError('任务不存在', 404);
  if (['queued', 'running', 'waiting_approval'].includes(String(task.status)))
    throw new RetrievalError('任务尚未结束，请结束后再查询历史证据', 409);
  /** tool_calls 表的查询记录集合。 */
  const rows = db
    .prepare(
      `SELECT id,name,status,substr(result,1,600) AS result,length(result) AS size,created_at,finished_at FROM tool_calls
    WHERE task_id=? ORDER BY rowid LIMIT 11 OFFSET ?`,
    )
    .all(taskId, offset);
  /** 当前可用工具集合。 */
  const tools = rows.slice(0, 10).map((row) => {
    /** 因数量或上下文容量限制被省略的条目。 */
    const omitted = [
      'search_memories',
      'search_tasks',
      'read_task',
      'search_skills',
      'read_skill',
      'read_skill_resource',
    ].includes(String(row.name));
    return {
      id: String(row.id),
      name: String(row.name),
      status: String(row.status),
      result: omitted
        ? '历史检索结果不回放，请重新查询当前数据。'
        : row.result === null
          ? null
          : String(row.result),
      truncated: !omitted && Number(row.size) > 600,
      createdAt: String(row.created_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
    };
  });
  // 将大结果按页返回；不提供配置快照、工具参数、批准决定或摘要。
  const result: TaskEvidence = {
    id: String(task.id),
    conversationId: String(task.conversation_id),
    status: String(task.status),
    kind: String(task.kind),
    input: String(task.input).slice(0, 800),
    error: task.error ? String(task.error).slice(0, 500) : null,
    createdAt: String(task.created_at),
    finishedAt: task.finished_at ? String(task.finished_at) : null,
    tools,
    nextOffset: rows.length > 10 ? offset + 10 : null,
    referenceOnly: true,
  };
  while (JSON.stringify(result).length > 14000 && result.tools.length) {
    result.tools.pop();
    result.nextOffset = offset + result.tools.length;
  }
  return result;
};
export class RetrievalSession {
  constructor(
    private db: DatabaseSync,
    private userId: string,
    private conversationId?: string,
  ) {}
  /** 读取可用记忆条目。 */
  memories(query: string) {
    return searchMemories(this.db, this.userId, query);
  }
  /** 读取关联任务列表。 */
  tasks(query: string) {
    if (!this.conversationId) throw new RetrievalError('未指定当前会话');
    return searchTasks(this.db, this.userId, query, this.conversationId);
  }
  /** 读取指定资源的内容。 */
  read(id: string, offset: number) {
    if (!this.conversationId) throw new RetrievalError('未指定当前会话');
    assertConversation(this.db, this.userId, this.conversationId);
    return readTask(this.db, this.userId, id, offset, this.conversationId);
  }
}
