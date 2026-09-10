import type { FastifyInstance } from 'fastify';
import type { ChannelManager } from '../channels/manager.js';
import type { WeixinLogin } from '../channels/login.js';

export function registerChannels(app: FastifyInstance, channels: ChannelManager, login: WeixinLogin) {
  app.get('/api/channels', async request => channels.view(request.userId));
  app.put<{ Body: { appId: string; appSecret?: string } }>('/api/channels/qq', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['appId'], properties: {
      appId: { type: 'string', pattern: '^[0-9]{1,32}$' }, appSecret: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S+$' },
    } } },
  }, async request => channels.configure(request.userId, 'qq', request.body.appId, request.body.appSecret));
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>('/api/channels/:id/state', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } },
  }, async request => { await channels.enable(request.params.id, request.userId, request.body.enabled); return { ok: true }; });
  app.delete<{ Params: { id: string } }>('/api/channels/:id', async request => { await channels.remove(request.params.id, request.userId); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/channels/:id/pairing', async request => channels.pairCode(request.params.id, request.userId));
  app.delete<{ Params: { id: string } }>('/api/channels/:id/pairing', async request => { await channels.unpair(request.params.id, request.userId); return { ok: true }; });
  app.post('/api/channels/weixin/login', async request => login.start(request.userId));
  app.get('/api/channels/weixin/login', async request => login.current(request.userId));
  app.get<{ Params: { id: string } }>('/api/channels/weixin/login/:id', async request => login.view(request.userId, request.params.id));
  app.post<{ Params: { id: string }; Body: { code: string } }>('/api/channels/weixin/login/:id/verify', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', pattern: '^[0-9]{1,12}$' } } } },
  }, async request => { login.verify(request.userId, request.params.id, request.body.code); return { ok: true }; });
  app.delete<{ Params: { id: string } }>('/api/channels/weixin/login/:id', async request => { await login.cancel(request.userId, request.params.id); return { ok: true }; });
}
