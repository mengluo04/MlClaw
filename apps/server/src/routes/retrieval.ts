import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { readTask, searchMemories, searchTasks, RetrievalError } from '../retrieval/search.js';

/** 注册检索相关 HTTP 接口及校验。 */
export const registerRetrieval = (app: FastifyInstance, db: DatabaseSync) => {
  /** 当前搜索关键词。 */
  const q = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
  app.get<{ Querystring: { q: string } }>(
    '/api/memories/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: { q },
        },
      },
    },
    async (request) => searchMemories(db, request.userId, request.query.q),
  );
  app.get<{ Querystring: { q: string; scope?: 'current' | 'all'; conversationId?: string } }>(
    '/api/tasks/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            q,
            scope: { type: 'string', enum: ['current', 'all'] },
            conversationId: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request) => {
      /** q：当前搜索关键词；scope：当前检索的数据范围；conversationId：当前会话标识。 */
      const { q, scope, conversationId } = request.query;
      if (scope !== 'all' && !conversationId)
        throw new RetrievalError('查询当前会话需要 conversationId');
      return searchTasks(db, request.userId, q, scope === 'all' ? undefined : conversationId);
    },
  );
  app.get<{ Params: { id: string }; Querystring: { offset?: string } }>(
    '/api/tasks/:id/evidence',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { offset: { type: 'string', pattern: '^\\d{1,4}$' } },
        },
      },
    },
    async (request) =>
      readTask(db, request.userId, request.params.id, Number(request.query.offset ?? 0)),
  );
};
