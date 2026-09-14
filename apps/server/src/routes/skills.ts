import type { FastifyInstance } from 'fastify';
import type { SkillStore } from '../skills/store.js';

/** 技能页面只读取工作区目录，不再维护数据库文本表单。 */
export const registerSkills = (app: FastifyInstance, store: SkillStore) => {
  app.get('/api/skills', async () => store.scan());
  app.get<{ Querystring: { q: string } }>(
    '/api/skills/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: { q: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } },
        },
      },
    },
    async (request) => store.search(request.query.q),
  );
  app.get<{ Params: { id: string } }>('/api/skills/:id', async (request) =>
    store.detail(request.params.id),
  );
};
