import type { FastifyInstance } from 'fastify';
import type { ScheduleBatchInput, ScheduleInput } from '@mlclaw/shared';
import type { ScheduleManager } from '../schedules/manager.js';

import {
  scheduleProperties as properties,
  scheduleVersion as version,
} from '../schedules/schema.js';

/** 读取并校验请求正文。 */
const body = (extra: Record<string, unknown> = {}) => ({
  type: 'object',
  additionalProperties: false,
  required: [...['name', 'kind', 'content', 'cron', 'enabled'], ...Object.keys(extra)],
  properties: { ...properties, ...extra },
});
/** 仅包含预期版本的请求体校验结构。 */
const versionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  properties: { expectedVersion: version },
};
/** 批量计划操作的请求体校验结构。 */
const batchBody = {
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'items'],
  properties: {
    operation: { type: 'string', enum: ['enable', 'disable', 'delete'] },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'expectedVersion'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          expectedVersion: version,
        },
      },
    },
  },
};
/** 注册定时计划集合相关 HTTP 接口及校验。 */
export const registerSchedules = (app: FastifyInstance, manager: ScheduleManager) => {
  /** 当前业务的数据存取实例。 */
  const store = manager.store;
  app.get('/api/reminders/unread', async (request) => ({ unread: store.unread(request.userId) }));
  app.get('/api/schedules', async (request) => ({
    schedules: store.list(request.userId),
    timezone: store.timezone,
    schedulerError: manager.commands?.error ?? manager.error,
    unread: store.unread(request.userId),
  }));
  app.post<{ Body: { cron: string } }>(
    '/api/schedules/preview',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['cron'],
          properties: { cron: properties.cron },
        },
      },
    },
    async (request) => store.preview(request.body.cron),
  );
  app.post<{ Body: ScheduleInput }>(
    '/api/schedules',
    { schema: { body: body() } },
    async (request, reply) => reply.code(201).send(store.save(request.userId, request.body)),
  );
  app.post<{ Body: ScheduleBatchInput }>(
    '/api/schedules/batch',
    { schema: { body: batchBody } },
    async (request) => store.batch(request.userId, request.body),
  );
  app.put<{ Params: { id: string }; Body: ScheduleInput & { expectedVersion: number } }>(
    '/api/schedules/:id',
    { schema: { body: body({ expectedVersion: version }) } },
    async (request) =>
      store.save(request.userId, request.body, request.params.id, request.body.expectedVersion),
  );
  app.delete<{ Params: { id: string }; Body: { expectedVersion: number } }>(
    '/api/schedules/:id',
    { schema: { body: versionBody } },
    async (request) => {
      store.remove(request.params.id, request.userId, request.body.expectedVersion);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: { idempotencyKey: string; expectedVersion: number } }>(
    '/api/schedules/:id/run',
    {
      schema: {
        body: {
          ...versionBody,
          required: ['expectedVersion', 'idempotencyKey'],
          properties: {
            expectedVersion: version,
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
      reply
        .code(202)
        .send(
          manager.runNow(
            request.params.id,
            request.userId,
            request.body.idempotencyKey,
            request.body.expectedVersion,
          ),
        ),
  );
  app.get<{ Querystring: { before?: string; scheduleId?: string; unread?: string } }>(
    '/api/schedule-occurrences',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            before: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' },
            scheduleId: { type: 'string', minLength: 1, maxLength: 100 },
            unread: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
    },
    async (request) =>
      store.history(
        request.userId,
        request.query.before ? Number(request.query.before) : undefined,
        request.query.scheduleId,
        request.query.unread === 'true',
      ),
  );
  app.post<{ Params: { id: string } }>('/api/schedule-occurrences/:id/cancel', async (request) => {
    manager.cancel(request.params.id, request.userId);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/schedule-occurrences/:id/read', async (request) => {
    store.markRead(request.params.id, request.userId);
    return { ok: true };
  });
};
