import type { FastifyInstance } from 'fastify';
import type { EmailConfigInput, WebhookConfigInput } from '@mlclaw/shared';
import type { ChannelManager } from '../channels/manager.js';
import type { WeixinLogin } from '../channels/login.js';

/** 注册channels相关 HTTP 接口及校验。 */
export const registerChannels = (
  app: FastifyInstance,
  channels: ChannelManager,
  login: WeixinLogin,
) => {
  app.get('/api/channels', async (request) => channels.view(request.userId));
  app.put<{ Body: EmailConfigInput }>(
    '/api/channels/email',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['host', 'port', 'security', 'username', 'from', 'to'],
          properties: {
            host: { type: 'string', minLength: 1, maxLength: 253 },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            security: { type: 'string', enum: ['tls', 'starttls'] },
            username: { type: 'string', minLength: 1, maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: 4096 },
            from: { type: 'string', minLength: 3, maxLength: 320 },
            to: { type: 'string', minLength: 3, maxLength: 320 },
          },
        },
      },
    },
    async (request) => channels.configureEmail(request.userId, request.body),
  );
  app.put<{ Body: WebhookConfigInput & { url?: string; token?: string } }>(
    '/api/channels/webhook',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', minLength: 1, maxLength: 4096 },
            token: { type: 'string', maxLength: 4096, pattern: '^\\S*$' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            headers: {
              type: 'object',
              maxProperties: 32,
              additionalProperties: { type: ['string', 'null'], maxLength: 8192 },
            },
            bodyTemplate: { type: 'string', maxLength: 32768 },
          },
        },
      },
    },
    async (request) =>
      channels.configure(
        request.userId,
        'webhook',
        'Webhook',
        request.body.token,
        request.body.url,
        request.body,
      ),
  );
  app.put<{ Body: { appId: string; appSecret?: string } }>(
    '/api/channels/qq',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['appId'],
          properties: {
            appId: { type: 'string', pattern: '^[0-9]{1,32}$' },
            appSecret: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S+$' },
          },
        },
      },
    },
    async (request) =>
      channels.configure(request.userId, 'qq', request.body.appId, request.body.appSecret),
  );
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/channels/:id/state',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      await channels.enable(request.params.id, request.userId, request.body.enabled);
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>('/api/channels/:id', async (request) => {
    await channels.remove(request.params.id, request.userId);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/channels/:id/pairing', async (request) =>
    channels.pairCode(request.params.id, request.userId),
  );
  app.delete<{ Params: { id: string } }>('/api/channels/:id/pairing', async (request) => {
    await channels.unpair(request.params.id, request.userId);
    return { ok: true };
  });
  app.post('/api/channels/weixin/login', async (request) => login.start(request.userId));
  app.get('/api/channels/weixin/login', async (request) => login.current(request.userId));
  app.get<{ Params: { id: string } }>('/api/channels/weixin/login/:id', async (request) =>
    login.view(request.userId, request.params.id),
  );
  app.post<{ Params: { id: string }; Body: { code: string } }>(
    '/api/channels/weixin/login/:id/verify',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code'],
          properties: { code: { type: 'string', pattern: '^[0-9]{1,12}$' } },
        },
      },
    },
    async (request) => {
      login.verify(request.userId, request.params.id, request.body.code);
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>('/api/channels/weixin/login/:id', async (request) => {
    await login.cancel(request.userId, request.params.id);
    return { ok: true };
  });
};
