import type { DefaultModel, TaskEvent } from '@mlclaw/shared';
import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { activeStates, TaskError, type TaskManager } from '../tasks/manager.js';
import { sessionValid } from '../auth/index.js';
import { skillLoads } from '../skills/session.js';

/** 注册对话相关 HTTP 接口及校验。 */
export const registerChat = (app: FastifyInstance, db: DatabaseSync, tasks: TaskManager) => {
  app.get('/api/runtime-status', async (request) => ({
    activeTask:
      db
        .prepare(
          "SELECT id, conversation_id AS conversationId, kind, status, created_at AS createdAt FROM tasks WHERE user_id=? AND status IN ('queued','running','waiting_approval') ORDER BY rowid LIMIT 1",
        )
        .get(request.userId) ?? null,
  }));
  /** 校验记录归属并返回对应数据。 */
  const owned = (id: string, userId: string) => {
    /** conversations 表的查询记录。 */
    const row = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId);
    if (!row) throw new TaskError('会话不存在', 404);
    return row;
  };
  /** 会话标题的运行时校验规则。 */
  const titleSchema = {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: { title: { type: 'string', minLength: 1, maxLength: 100 } },
    },
  };
  app.get('/api/conversations', async (request) =>
    db
      .prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY rowid DESC LIMIT 200')
      .all(request.userId),
  );
  app.post<{ Body: { title: string } }>(
    '/api/conversations',
    { schema: titleSchema },
    async (request) => {
      /** 当前记录标识。 */
      const id = randomUUID();
      db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run(
        id,
        request.userId,
        request.body.title,
        formatSystemTime(),
      );
      return owned(id, request.userId);
    },
  );
  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (request) => ({
    ...owned(request.params.id, request.userId),
    latestTask:
      db
        .prepare('SELECT * FROM tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1')
        .get(request.params.id) ?? null,
  }));
  app.patch<{ Params: { id: string }; Body: { title: string } }>(
    '/api/conversations/:id',
    { schema: titleSchema },
    async (request) => {
      owned(request.params.id, request.userId);
      db.prepare('UPDATE conversations SET title=? WHERE id=?').run(
        request.body.title,
        request.params.id,
      );
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (request) => {
    owned(request.params.id, request.userId);
    if (
      db
        .prepare(
          "SELECT id FROM tasks WHERE conversation_id=? AND status IN ('queued','running','waiting_approval')",
        )
        .get(request.params.id)
    )
      throw new TaskError('请先取消运行中的任务', 409);
    db.prepare('DELETE FROM conversations WHERE id=?').run(request.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    '/api/conversations/:id/messages',
    async (request) => {
      owned(request.params.id, request.userId);
      /** 操作前的状态或分页起点。 */
      const before = request.query.before ? Number(request.query.before) : Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(before) || before < 1) throw new TaskError('分页游标无效');
      /** messages 表的查询记录集合。 */
      const rows = db
        .prepare(
          'SELECT rowid AS cursor, * FROM messages WHERE conversation_id=? AND rowid < ? ORDER BY rowid DESC LIMIT 51',
        )
        .all(request.params.id, before);
      /** 当前页面或分页结果。 */
      const page = rows.slice(0, 50);
      return {
        messages: page.reverse(),
        nextCursor: rows.length > 50 ? String(page[0]!.cursor) : null,
      };
    },
  );
  app.post<{
    Params: { id: string };
    Body: { content: string; idempotencyKey: string; modelChoice?: DefaultModel };
  }>(
    '/api/conversations/:id/messages',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['content', 'idempotencyKey'],
          properties: {
            modelChoice: {
              type: 'object',
              additionalProperties: false,
              required: ['providerId', 'model'],
              properties: {
                providerId: { type: 'string', minLength: 1, maxLength: 100 },
                model: { type: 'string', minLength: 1, maxLength: 200 },
              },
            },
            content: { type: 'string', minLength: 1, maxLength: 8000, pattern: '\\S' },
            idempotencyKey: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              pattern: '^[A-Za-z0-9_-]+$',
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(202).send({
        taskId: tasks.create(
          request.userId,
          request.params.id,
          request.body.content,
          request.body.idempotencyKey,
          request.body.modelChoice,
        ),
      }),
  );
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request) => ({
    ...tasks.get(request.params.id, request.userId),
    skills: skillLoads(db, request.params.id),
    tools: db
      .prepare('SELECT * FROM tool_calls WHERE task_id=? ORDER BY rowid')
      .all(request.params.id),
  }));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request) => {
    tasks.cancel(request.params.id, request.userId);
    return { ok: true };
  });
  // 历史从数据库补发；接入当前正文快照后直接订阅内存事件。
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (/* 逐项处理关闭。 */ const close of streams) close();
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/tasks/:id/events',
    async (request, reply) => {
      tasks.get(request.params.id, request.userId);
      /** 当前分页游标。 */
      let cursor = Number(request.headers['last-event-id'] ?? request.query.after ?? '0');
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TaskError('事件游标无效');
      if (streams.size >= 8) throw new TaskError('事件订阅过多', 429);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders();
      /** 是否已经停止。 */
      let stopped = false;
      let replaying = true;
      let waitingDrain = false;
      let missed = false;
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setInterval> | undefined;
      let continuation: ReturnType<typeof setImmediate> | undefined;
      /** 关闭当前资源或编辑界面。 */
      const close = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        clearImmediate(continuation);
        unsubscribe();
        streams.delete(close);
        reply.raw.end();
      };
      const write = (event: TaskEvent, snapshot = false) => {
        if (stopped) return false;
        cursor = event.id;
        return reply.raw.write(
          `${snapshot ? 'event: snapshot\n' : ''}id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      };
      const scheduleReplay = () => {
        continuation = setImmediate(replay);
      };
      /** 回放时服从背压并分页让出线程；最后同步切换到内存订阅，没有漏事件窗口。 */
      const replay = () => {
        if (stopped) return;
        try {
          if (!sessionValid(db, request)) return close();
          /** task_events 表的查询记录集合。 */
          const rows = db
            .prepare('SELECT * FROM task_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 100')
            .all(request.params.id, cursor);
          for (/* 逐项处理当前数据库记录。 */ const row of rows) {
            /** 带有稳定事件标识的 SSE 事件封装。 */
            const envelope = {
              id: Number(row.seq),
              taskId: request.params.id,
              type: String(row.type),
              data: JSON.parse(String(row.data)) as unknown,
              createdAt: String(row.created_at),
            };
            if (!write(envelope as TaskEvent)) {
              reply.raw.once('drain', scheduleReplay);
              return;
            }
          }
          if (rows.length === 100) return scheduleReplay();
          const snapshot = tasks.output.snapshot(request.params.id);
          // 即使旧游标高于重启后的持久化位置，也用快照重置客户端。
          waitingDrain = !write(snapshot, true);
          replaying = false;
          if (!activeStates.includes(snapshot.data.status ?? '')) return close();
        } catch {
          close();
        }
      };
      unsubscribe = tasks.output.subscribe(request.params.id, (event) => {
        if (stopped || replaying) return;
        try {
          // 背压期间只记需要追赶，不积累增量队列；排空后补业务事件及当前正文快照。
          if (waitingDrain) {
            missed = true;
            return;
          }
          waitingDrain = !write(event);
          if (['task.finished', 'task.failed', 'task.cancelled'].includes(event.type)) close();
        } catch {
          close();
        }
      });
      reply.raw.on('drain', () => {
        waitingDrain = false;
        if (missed && !replaying && !stopped) {
          missed = false;
          replaying = true;
          scheduleReplay();
        }
      });
      timer = setInterval(() => {
        try {
          if (!sessionValid(db, request) || reply.raw.writableLength > 262144) return close();
          reply.raw.write(': heartbeat\n\n');
        } catch {
          close();
        }
      }, 1000);
      streams.add(close);
      reply.raw.once('close', close);
      replay();
    },
  );
};
