import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { TaskError, type TaskManager } from '../tasks/manager.js';
import { ToolError } from '../tools/files.js';

/** 注册工作区相关 HTTP 接口及校验。 */
export const registerWorkspace = (app: FastifyInstance, db: DatabaseSync, tasks: TaskManager) => {
  /** 文件工作区实例。 */
  const workspace = tasks.registry.workspace;
  /** 准备或执行指定文件操作。 */
  const fileOperation = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      if (error instanceof ToolError) throw new TaskError(error.message);
      throw error;
    }
  };
  app.get<{ Querystring: { path?: string } }>('/api/files', async (request) =>
    fileOperation(() => workspace.list(request.query.path ?? '.')),
  );
  app.get<{ Querystring: { path: string } }>(
    '/api/files/download',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      /** 当前内容的字节数据。 */
      const bytes = fileOperation(() => workspace.readBytes(request.query.path));
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(basename(request.query.path)).replace(/'/g, '%27')}`,
        )
        .send(bytes);
    },
  );
  app.post<{ Body: { path: string; contentBase64: string } }>(
    '/api/files/upload',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'contentBase64'],
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 500 },
            contentBase64: {
              type: 'string',
              maxLength: 87384,
              pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
            },
          },
        },
      },
    },
    async (request) => {
      tasks.assertWorkspaceIdle();
      return fileOperation(() => {
        /** 当前内容的字节数据。 */
        const bytes = Buffer.from(request.body.contentBase64, 'base64');
        if (bytes.toString('base64') !== request.body.contentBase64)
          throw new ToolError('上传编码无效');
        return workspace.writeBytes(
          request.body.path,
          bytes,
          workspace.snapshot(request.body.path),
          new AbortController().signal,
        );
      });
    },
  );
  /** 工作区相对路径的请求参数校验结构。 */
  const pathSchema = { type: 'string', minLength: 1, maxLength: 500 };
  app.post<{ Body: { path: string } }>(
    '/api/files/directory',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: pathSchema },
        },
      },
    },
    async (request) => {
      tasks.assertWorkspaceIdle();
      return fileOperation(() => workspace.mkdir(request.body.path, new AbortController().signal));
    },
  );
  app.post<{ Body: { source: string; destination: string } }>(
    '/api/files/move',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['source', 'destination'],
          properties: { source: pathSchema, destination: pathSchema },
        },
      },
    },
    async (request) => {
      tasks.assertWorkspaceIdle();
      return fileOperation(() =>
        workspace.move(request.body.source, request.body.destination, new AbortController().signal),
      );
    },
  );
  app.delete<{ Body: { path: string; recursive: boolean } }>(
    '/api/files',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'recursive'],
          properties: { path: pathSchema, recursive: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      tasks.assertWorkspaceIdle();
      return fileOperation(() =>
        workspace.remove(request.body.path, request.body.recursive, new AbortController().signal),
      );
    },
  );
  app.get('/api/memories', async (request) =>
    db
      .prepare('SELECT * FROM memories WHERE user_id=? ORDER BY priority DESC, updated_at DESC')
      .all(request.userId),
  );
  /** 长期记忆内容与优先级的请求体校验结构。 */
  const memorySchema = {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['content', 'priority'],
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
        priority: { type: 'integer', minimum: -10, maximum: 10 },
      },
    },
  };
  /** 保存长期记忆条目。 */
  const saveMemory = (
    userId: string,
    id: string,
    content: string,
    priority: number,
    edit = false,
  ) => {
    if (edit && !db.prepare('SELECT id FROM memories WHERE id=? AND user_id=?').get(id, userId))
      throw new TaskError('记忆不存在', 404);
    /** 当前用户记忆的数量与容量统计。 */
    const totals = db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(length(content)),0) AS size FROM memories WHERE user_id=? AND id<>?',
      )
      .get(userId, id)!;
    if (Number(totals.n) >= 100 || Number(totals.size) + content.length > 32000)
      throw new TaskError('记忆超过 100 条或 32000 字符总容量');
    /** 当前时间。 */
    const now = formatSystemTime();
    db.prepare(
      'INSERT INTO memories VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content, priority=excluded.priority, updated_at=excluded.updated_at',
    ).run(id, userId, content, priority, now, now);
    return { id, content, priority };
  };
  app.post<{ Body: { content: string; priority: number } }>(
    '/api/memories',
    { schema: memorySchema },
    async (request) =>
      saveMemory(request.userId, randomUUID(), request.body.content, request.body.priority),
  );
  app.patch<{ Params: { id: string }; Body: { content: string; priority: number } }>(
    '/api/memories/:id',
    { schema: memorySchema },
    async (request) =>
      saveMemory(
        request.userId,
        request.params.id,
        request.body.content,
        request.body.priority,
        true,
      ),
  );
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (request) => {
    /** memories 表的操作结果。 */
    const result = db
      .prepare('DELETE FROM memories WHERE id=? AND user_id=?')
      .run(request.params.id, request.userId);
    if (!result.changes) throw new TaskError('记忆不存在', 404);
    return { ok: true };
  });
  app.get<{ Querystring: { conversationId?: string } }>('/api/tasks', async (request) => {
    if (request.query.conversationId)
      return db
        .prepare(
          'SELECT * FROM tasks WHERE user_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 100',
        )
        .all(request.userId, request.query.conversationId);
    return db
      .prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY rowid DESC LIMIT 100')
      .all(request.userId);
  });
};
