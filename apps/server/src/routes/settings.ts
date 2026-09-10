import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { DefaultModel } from '@mlclaw/shared';
import { record } from '../providers/types.js';
import { deleteProvider, getModelConfig, getSettings, saveProvider, setDefault, type ProviderInput } from '../models/store.js';
const providerSchema = { type: 'object', additionalProperties: false, required: ['name', 'baseUrl', 'models'], properties: {
  name: { type: 'string', minLength: 1, maxLength: 100 }, baseUrl: { type: 'string', minLength: 1, maxLength: 2048 },
  models: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } },
  apiKey: { type: 'string', maxLength: 4096 },
} };
export function registerSettings(app: FastifyInstance, db: DatabaseSync) {
  app.get('/api/settings/models', async request => getSettings(db, request.userId));
  app.post<{ Body: ProviderInput }>('/api/settings/providers', { schema: { body: providerSchema } }, async request => saveProvider(db, request.userId, request.body));
  app.put<{ Params: { id: string }; Body: ProviderInput }>('/api/settings/providers/:id', { schema: { body: providerSchema } }, async request => saveProvider(db, request.userId, request.body, request.params.id));
  app.delete<{ Params: { id: string } }>('/api/settings/providers/:id', async request => { deleteProvider(db, request.userId, request.params.id); return { ok: true }; });
  app.put<{ Body: DefaultModel }>('/api/settings/model-default', { schema: { body: { type: 'object', additionalProperties: false, required: ['providerId', 'model'], properties: {
    providerId: { type: 'string', minLength: 1, maxLength: 200 }, model: { type: 'string', minLength: 1, maxLength: 200 },
  } } } }, async request => { setDefault(db, request.userId, request.body); return { ok: true }; });
  app.post<{ Params: { id: string }; Body: { model: string } }>('/api/settings/providers/:id/test', { schema: { body: { type: 'object', additionalProperties: false, required: ['model'], properties: { model: { type: 'string', minLength: 1, maxLength: 200 } } } } }, async (request, reply) => {
    const config = getModelConfig(db, request.userId, { providerId: request.params.id, model: request.body.model });
    if (!config) return reply.code(404).send({ message: '提供商或模型不存在，请先保存配置' });
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 8, stream: false }),
      });
      if (!response.ok) { await response.body?.cancel(); return reply.code(502).send({ message: `模型服务连接失败（HTTP ${response.status}）` }); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('empty response');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) throw new Error('response too large'); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(value) || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)) return reply.code(502).send({ message: '模型服务未返回有效对话响应' });
      return { ok: true };
    } catch { return reply.code(502).send({ message: '模型服务连接失败或超时，请检查配置' }); }
  });
}
