import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { DefaultModel } from '@mlclaw/shared';
import { record } from '../providers/types.js';
import { providerPresets } from '../models/catalog.js';
import { discoverModels } from '../models/discovery.js';
import {
  deleteProvider,
  getModelConfig,
  getSettings,
  saveProvider,
  setDefault,
  type ProviderInput,
  type DiscoveryInput,
  resolveProviderConnection,
  ModelSettingsError,
} from '../models/store.js';
/** 提供商配置的运行时 JSON Schema 校验规则。 */
const providerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'baseUrl', 'models'],
  properties: {
    presetId: { type: 'string', enum: providerPresets.map((p) => p.id) },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    baseUrl: { type: 'string', minLength: 1, maxLength: 2048 },
    models: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 200 },
    },
    apiKey: { type: 'string', maxLength: 4096 },
  },
};
/** 注册设置相关 HTTP 接口及校验。 */
export const registerSettings = (app: FastifyInstance, db: DatabaseSync) => {
  app.get('/api/settings/provider-presets', async () => ({ providers: providerPresets }));
  /** 模型发现请求状态。 */
  const discovering = new Set<string>();
  /** 执行模型发现并跟踪请求状态。 */
  const runDiscovery = async (userId: string, input: DiscoveryInput, signal: AbortSignal) => {
    /** 当前流程使用的配置。 */
    const config = resolveProviderConnection(db, userId, input);
    if (discovering.has(userId))
      throw new ModelSettingsError('正在获取模型列表，请等待当前请求完成', 409);
    discovering.add(userId);
    try {
      return await discoverModels(config, signal);
    } finally {
      discovering.delete(userId);
    }
  };
  app.post<{ Body: DiscoveryInput }>(
    '/api/settings/model-discovery',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['baseUrl'],
          properties: {
            providerId: { type: 'string', minLength: 1, maxLength: 200 },
            baseUrl: providerSchema.properties.baseUrl,
            presetId: providerSchema.properties.presetId,
            apiKey: providerSchema.properties.apiKey,
          },
        },
      },
    },
    async (request, reply) => {
      /** 用于主动取消当前操作的控制器。 */
      const controller = new AbortController();
      /** 取消当前执行并更新相关状态。 */
      const cancel = () => controller.abort();
      reply.raw.once('close', cancel);
      try {
        return await runDiscovery(request.userId, request.body, controller.signal);
      } finally {
        reply.raw.off('close', cancel);
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/settings/providers/:id/models',
    async (request, reply) => {
      /** 当前模型或联网服务提供商。 */
      const provider = getSettings(db, request.userId).providers.find(
        (p) => p.id === request.params.id,
      );
      if (!provider) throw new ModelSettingsError('提供商不存在', 404);
      /** 用于主动取消当前操作的控制器。 */
      const controller = new AbortController();
      /** 取消当前执行并更新相关状态。 */
      const cancel = () => controller.abort();
      reply.raw.once('close', cancel);
      try {
        return await runDiscovery(
          request.userId,
          { providerId: provider.id, baseUrl: provider.baseUrl },
          controller.signal,
        );
      } finally {
        reply.raw.off('close', cancel);
      }
    },
  );
  app.get('/api/settings/models', async (request) => getSettings(db, request.userId));
  app.post<{ Body: ProviderInput }>(
    '/api/settings/providers',
    { schema: { body: providerSchema } },
    async (request) => saveProvider(db, request.userId, request.body),
  );
  app.put<{ Params: { id: string }; Body: ProviderInput }>(
    '/api/settings/providers/:id',
    { schema: { body: providerSchema } },
    async (request) => saveProvider(db, request.userId, request.body, request.params.id),
  );
  app.delete<{ Params: { id: string } }>('/api/settings/providers/:id', async (request) => {
    deleteProvider(db, request.userId, request.params.id);
    return { ok: true };
  });
  app.put<{ Body: DefaultModel }>(
    '/api/settings/model-default',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['providerId', 'model'],
          properties: {
            providerId: { type: 'string', minLength: 1, maxLength: 200 },
            model: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request) => {
      setDefault(db, request.userId, request.body);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string }; Body: { model: string } }>(
    '/api/settings/providers/:id/test',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['model'],
          properties: { model: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      /** 当前流程使用的配置。 */
      const config = getModelConfig(db, request.userId, {
        providerId: request.params.id,
        model: request.body.model,
      });
      if (!config) return reply.code(404).send({ message: '提供商或模型不存在，请先保存配置' });
      try {
        /** 请求返回的响应。 */
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: 'Reply OK' }],
            max_tokens: 8,
            stream: false,
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return reply.code(502).send({ message: `模型服务连接失败（HTTP ${response.status}）` });
        }
        /** 流数据读取器。 */
        const reader = response.body?.getReader();
        if (!reader) throw new Error('empty response');
        /** 已收集的数据分块。 */
        const chunks: Uint8Array[] = [];
        /** 当前数据大小。 */
        let size = 0;
        try {
          while (true) {
            /** 当前处理的内容片段。 */
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 65536) throw new Error('response too large');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        /** 从 JSON 文本解析的结构化数据，后续仍需按业务规则校验。 */
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !record(value) ||
          !Array.isArray(value.choices) ||
          !record(value.choices[0]) ||
          !record(value.choices[0].message)
        )
          return reply.code(502).send({ message: '模型服务未返回有效对话响应' });
        return { ok: true };
      } catch {
        return reply.code(502).send({ message: '模型服务连接失败或超时，请检查配置' });
      }
    },
  );
};
