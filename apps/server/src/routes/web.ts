import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { WebSettingsInput } from '@mlclaw/shared';
import { getWebConfig, publicWebConfig, saveWebConfig } from '../web/store.js';
import type { WebService } from '../web/service.js';

/** 注册联网服务相关 HTTP 接口及校验。 */
export const registerWeb = (app: FastifyInstance, db: DatabaseSync, service: WebService) => {
  app.get('/api/settings/web', async (request) =>
    publicWebConfig(getWebConfig(db, request.userId)),
  );
  app.put<{ Body: WebSettingsInput }>(
    '/api/settings/web',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['provider', 'enabled', 'allowFetch', 'allowSchedules', 'expectedVersion'],
          properties: {
            provider: {
              enum: ['tavily', 'firecrawl', 'exa', 'brave', 'searxng'],
              type: 'string',
            },
            enabled: { type: 'boolean' },
            allowFetch: { type: 'boolean' },
            allowSchedules: { type: 'boolean' },
            apiKey: { type: 'string', maxLength: 4096 },
            baseUrl: { type: 'string', maxLength: 2048 },
            expectedVersion: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      /** 本次处理结果。 */
      const result = saveWebConfig(db, request.userId, request.body);
      service.cancel(request.userId);
      return result;
    },
  );
  app.post<{ Body: { expectedVersion: number } }>(
    '/api/settings/web/test',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          properties: { expectedVersion: { type: 'integer', minimum: 0 } },
        },
      },
    },
    async (request) => service.test(request.userId, request.body.expectedVersion),
  );
};
