import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { activeStates, TaskError, type TaskManager } from '../tasks/manager.js';
import { sessionValid } from '../auth/index.js';
import { skillLoads } from '../skills/session.js';
import { ToolError } from '../tools/files.js';

export function registerChat(app: FastifyInstance, db: DatabaseSync, tasks: TaskManager) {
  app.get('/api/runtime-status', async request => ({ activeTask: db.prepare("SELECT id, conversation_id AS conversationId, kind, status, created_at AS createdAt FROM tasks WHERE user_id=? AND status IN ('queued','running','waiting_approval') ORDER BY rowid LIMIT 1").get(request.userId) ?? null }));
  const owned = (id: string, userId: string) => {
    const row = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId);
    if (!row) throw new TaskError('会话不存在', 404); return row;
  };
  const titleSchema = { body: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 100 } } } };
  app.get('/api/conversations', async request => db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY rowid DESC LIMIT 200').all(request.userId));
  app.post<{ Body: { title: string } }>('/api/conversations', { schema: titleSchema }, async request => {
    const id = randomUUID();
    db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run(id, request.userId, request.body.title, formatSystemTime());
    return owned(id, request.userId);
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id', async request => ({ ...owned(request.params.id, request.userId), latestTask: db.prepare('SELECT * FROM tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(request.params.id) ?? null }));
  app.patch<{ Params: { id: string }; Body: { title: string } }>('/api/conversations/:id', { schema: titleSchema }, async request => {
    owned(request.params.id, request.userId); db.prepare('UPDATE conversations SET title=? WHERE id=?').run(request.body.title, request.params.id); return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async request => {
    owned(request.params.id, request.userId);
    if (db.prepare("SELECT id FROM tasks WHERE conversation_id=? AND status IN ('queued','running','waiting_approval')").get(request.params.id)) throw new TaskError('请先取消运行中的任务', 409);
    db.prepare('DELETE FROM conversations WHERE id=?').run(request.params.id); return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>('/api/conversations/:id/messages', async request => {
    owned(request.params.id, request.userId);
    const before = request.query.before ? Number(request.query.before) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1) throw new TaskError('分页游标无效');
    const rows = db.prepare('SELECT rowid AS cursor, * FROM messages WHERE conversation_id=? AND rowid < ? ORDER BY rowid DESC LIMIT 51').all(request.params.id, before);
    const page = rows.slice(0, 50);
    return { messages: page.reverse(), nextCursor: rows.length > 50 ? String(page[0]!.cursor) : null };
  });
  app.post<{ Params: { id: string }; Body: { content: string; idempotencyKey: string } }>('/api/conversations/:id/messages', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['content', 'idempotencyKey'], properties: { content: { type: 'string', minLength: 1, maxLength: 8000, pattern: '\\S' }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' } } } },
  }, async (request, reply) => reply.code(202).send({ taskId: tasks.create(request.userId, request.params.id, request.body.content, request.body.idempotencyKey) }));
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async request => ({ ...tasks.get(request.params.id, request.userId), skills: skillLoads(db, request.params.id), tools: db.prepare('SELECT * FROM tool_calls WHERE task_id=? ORDER BY rowid').all(request.params.id) }));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async request => { tasks.cancel(request.params.id, request.userId); return { ok: true }; });
  app.post<{ Params: { id: string }; Body: { approved: boolean; argumentsDigest: string } }>('/api/tool-calls/:id/decision', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['approved', 'argumentsDigest'], properties: { approved: { type: 'boolean' }, argumentsDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } },
  }, async request => {
    try { tasks.approvals.decide(request.params.id, request.userId, request.body.argumentsDigest, request.body.approved); }
    catch (error) { if (error instanceof ToolError) throw new TaskError(error.message, 409); throw error; }
    return { ok: true };
  });

  // 从持久化事件按游标补发；轮询避免注册监听器与回放之间的事件丢失窗口。
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of streams) close(); });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/tasks/:id/events', async (request, reply) => {
    tasks.get(request.params.id, request.userId);
    let cursor = Number(request.headers['last-event-id'] ?? request.query.after ?? '0');
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TaskError('事件游标无效');
    if (streams.size >= 8) throw new TaskError('事件订阅过多', 429);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    reply.raw.flushHeaders();
    let stopped = false; let ticks = 0;
    const close = () => { if (stopped) return; stopped = true; clearInterval(timer); streams.delete(close); reply.raw.end(); };
    const pump = () => {
      if (stopped) return;
      try {
        if (!sessionValid(db, request)) return close();
        if (reply.raw.writableLength > 262144) return close();
        const rows = db.prepare('SELECT * FROM task_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 100').all(request.params.id, cursor);
        for (const row of rows) {
          const envelope = { id: Number(row.seq), taskId: request.params.id, type: String(row.type), data: JSON.parse(String(row.data)) as unknown, createdAt: String(row.created_at) };
          reply.raw.write(`id: ${row.seq}\ndata: ${JSON.stringify(envelope)}\n\n`); cursor = Number(row.seq);
        }
        const state = db.prepare('SELECT status FROM tasks WHERE id=?').get(request.params.id);
        if ((!state || !activeStates.includes(String(state.status))) && rows.length < 100) return close();
        if (++ticks % 40 === 0) reply.raw.write(': heartbeat\n\n');
      } catch { close(); }
    };
    const timer = setInterval(pump, 250); streams.add(close); reply.raw.once('close', close); pump();
  });
}
