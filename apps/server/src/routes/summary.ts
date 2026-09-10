import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { getConversationContext, setConversationContext } from '../agent/summary.js';
import type { TaskManager } from '../tasks/manager.js';

export function registerSummary(app: FastifyInstance, db: DatabaseSync, tasks: TaskManager) {
  const version = { type: 'integer', minimum: 0 };
  app.get<{ Params: { id: string } }>('/api/conversations/:id/context', async request => getConversationContext(db, request.userId, request.params.id));
  app.put<{ Params: { id: string }; Body: { autoSummary: boolean; expectedVersion: number } }>('/api/conversations/:id/context', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['autoSummary', 'expectedVersion'], properties: { autoSummary: { type: 'boolean' }, expectedVersion: version },
  } } }, async request => setConversationContext(db, request.userId, request.params.id, request.body.expectedVersion, request.body.autoSummary));
  app.post<{ Params: { id: string }; Body: { idempotencyKey: string; expectedVersion: number } }>('/api/conversations/:id/summary', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['idempotencyKey', 'expectedVersion'], properties: { expectedVersion: version, idempotencyKey: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' } },
  } } }, async (request, reply) => reply.code(202).send({ taskId: tasks.createSummary(request.userId, request.params.id, request.body.idempotencyKey, request.body.expectedVersion) }));
  app.delete<{ Params: { id: string }; Body: { expectedVersion: number } }>('/api/conversations/:id/summary', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion: version },
  } } }, async request => {
    const current = getConversationContext(db, request.userId, request.params.id);
    return setConversationContext(db, request.userId, request.params.id, request.body.expectedVersion, current.autoSummary, true);
  });
}
