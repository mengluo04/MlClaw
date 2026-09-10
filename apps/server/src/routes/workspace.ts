import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { TaskError, type TaskManager } from '../tasks/manager.js';
import { ToolError } from '../tools/files.js';

export function registerWorkspace(app: FastifyInstance, db: DatabaseSync, tasks: TaskManager) {
  const workspace = tasks.registry.workspace;
  const fileOperation = <T>(fn: () => T): T => { try { return fn(); } catch (error) { if (error instanceof ToolError) throw new TaskError(error.message); throw error; } };
  app.get<{ Querystring: { path?: string } }>('/api/files', async request => fileOperation(() => workspace.list(request.query.path ?? '.')));
  app.get<{ Querystring: { path: string } }>('/api/files/download', {
    schema: { querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 500 } } } },
  }, async (request, reply) => {
    const bytes = fileOperation(() => workspace.readBytes(request.query.path));
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(basename(request.query.path)).replace(/'/g, '%27')}`).send(bytes);
  });
  app.post<{ Body: { path: string; contentBase64: string } }>('/api/files/upload', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['path', 'contentBase64'], properties: { path: { type: 'string', minLength: 1, maxLength: 500 }, contentBase64: { type: 'string', maxLength: 87384, pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' } } } },
  }, async request => {
    tasks.assertWorkspaceIdle();
    return fileOperation(() => {
      const bytes = Buffer.from(request.body.contentBase64, 'base64');
      if (bytes.toString('base64') !== request.body.contentBase64) throw new ToolError('上传编码无效');
      if (workspace.snapshot(request.body.path) !== 'absent') throw new TaskError('同名文件已存在，请使用新名称；覆盖须通过工具授权', 409);
      return workspace.writeBytes(request.body.path, bytes, 'absent', new AbortController().signal);
    });
  });
  app.get('/api/memories', async request => db.prepare('SELECT * FROM memories WHERE user_id=? ORDER BY priority DESC, updated_at DESC').all(request.userId));
  const memorySchema = { body: { type: 'object', additionalProperties: false, required: ['content', 'priority'], properties: { content: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' }, priority: { type: 'integer', minimum: -10, maximum: 10 } } } };
  const saveMemory = (userId: string, id: string, content: string, priority: number, edit = false) => {
    if (edit && !db.prepare('SELECT id FROM memories WHERE id=? AND user_id=?').get(id, userId)) throw new TaskError('记忆不存在', 404);
    const totals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(content)),0) AS size FROM memories WHERE user_id=? AND id<>?').get(userId, id)!;
    if (Number(totals.n) >= 100 || Number(totals.size) + content.length > 32000) throw new TaskError('记忆超过 100 条或 32000 字符总容量');
    const now = formatSystemTime();
    db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content, priority=excluded.priority, updated_at=excluded.updated_at').run(id, userId, content, priority, now, now);
    return { id, content, priority };
  };
  app.post<{ Body: { content: string; priority: number } }>('/api/memories', { schema: memorySchema }, async request => saveMemory(request.userId, randomUUID(), request.body.content, request.body.priority));
  app.patch<{ Params: { id: string }; Body: { content: string; priority: number } }>('/api/memories/:id', { schema: memorySchema }, async request => saveMemory(request.userId, request.params.id, request.body.content, request.body.priority, true));
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async request => {
    const result = db.prepare('DELETE FROM memories WHERE id=? AND user_id=?').run(request.params.id, request.userId); if (!result.changes) throw new TaskError('记忆不存在', 404); return { ok: true };
  });
  app.get<{ Querystring: { conversationId?: string } }>('/api/tasks', async request => {
    if (request.query.conversationId) return db.prepare('SELECT * FROM tasks WHERE user_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 100').all(request.userId, request.query.conversationId);
    return db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY rowid DESC LIMIT 100').all(request.userId);
  });
}
