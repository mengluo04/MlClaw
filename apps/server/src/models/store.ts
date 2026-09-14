import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DefaultModel, ModelProvider, ModelSettings } from '@mlclaw/shared';
import type { ModelConfig } from '../providers/types.js';
import { transaction } from '../db/index.js';
import { providerPresets } from './catalog.js';

export class ModelSettingsError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export interface ProviderInput {
  presetId?: string;
  name: string;
  baseUrl: string;
  models: string[];
  apiKey?: string;
}
/** 读取当前设置。 */
export const getSettings = (db: DatabaseSync, userId: string): ModelSettings => {
  /** 可用模型提供商列表。 */
  const providers: ModelProvider[] = db
    .prepare(
      'SELECT id,name,base_url,models,preset_id,length(api_key)>0 AS has_key FROM model_providers WHERE user_id=? ORDER BY rowid',
    )
    .all(userId)
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      baseUrl: String(row.base_url),
      models: JSON.parse(String(row.models)) as string[],
      hasApiKey: Boolean(row.has_key),
      presetId: String(row.preset_id),
    }));
  /** model_defaults 表的查询记录。 */
  const row = db
    .prepare('SELECT provider_id,model FROM model_defaults WHERE user_id=?')
    .get(userId);
  return {
    providers,
    defaultModel: row ? { providerId: String(row.provider_id), model: String(row.model) } : null,
  };
};
/** 取得默认模型对应的服务端调用配置。 */
export const getModelConfig = (
  db: DatabaseSync,
  userId: string,
  choice?: DefaultModel,
): (ModelConfig & { providerId: string; providerName: string }) | undefined => {
  /** 当前选中项。 */
  const selected = choice ?? getSettings(db, userId).defaultModel;
  if (!selected) return;
  /** model_providers 表的查询记录。 */
  const row = db
    .prepare('SELECT * FROM model_providers WHERE id=? AND user_id=?')
    .get(selected.providerId, userId);
  if (!row || !(JSON.parse(String(row.models)) as string[]).includes(selected.model)) return;
  return {
    providerId: String(row.id),
    providerName: String(row.name),
    baseUrl: String(row.base_url),
    model: selected.model,
    apiKey: String(row.api_key),
  };
};
/** 校验并规范化模型服务基础地址。 */
export const normalizeModelUrl = (baseUrl: string): string => {
  /** 当前请求或资源地址。 */
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelSettingsError('模型服务地址无效');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new ModelSettingsError(
      '模型地址须使用 HTTPS；仅本机允许 HTTP，禁止 URL 凭据、查询和片段',
    );
  return url.href.replace(/\/+$/, '');
};

export interface DiscoveryInput {
  providerId?: string;
  baseUrl: string;
  presetId?: string;
  apiKey?: string;
}
/** 选择已保存或草稿提供商的有效连接配置。 */
export const resolveProviderConnection = (
  db: DatabaseSync,
  userId: string,
  input: DiscoveryInput,
) => {
  /** model_providers 表的查询记录。 */
  const previous = input.providerId
    ? db
        .prepare('SELECT * FROM model_providers WHERE id=? AND user_id=?')
        .get(input.providerId, userId)
    : undefined;
  if (input.providerId && !previous) throw new ModelSettingsError('提供商不存在', 404);
  /** 服务基础地址。 */
  const baseUrl = normalizeModelUrl(input.baseUrl);
  /** 当前提供商预设标识。 */
  const presetId = input.presetId ?? String(previous?.preset_id ?? 'custom');
  if (!providerPresets.some((p) => p.id === presetId))
    throw new ModelSettingsError('提供商预设无效');
  /** 仅在当前调用或编辑流程中使用的服务密钥。 */
  const apiKey =
    input.apiKey ??
    (previous?.base_url === baseUrl && previous.preset_id === presetId
      ? String(previous.api_key)
      : '');
  return { baseUrl, presetId, apiKey };
};

/** 校验并保存提供商、密钥和模型列表。 */
export const saveProvider = (
  db: DatabaseSync,
  userId: string,
  input: ProviderInput,
  id?: string,
) => {
  /** 当前对象名称。 */
  const name = input.name.trim();
  /** 当前可用模型列表。 */
  const models = input.models.map((model) => model.trim());
  if (
    !name ||
    !models.length ||
    models.length > 50 ||
    models.some((model) => !model || model.length > 200) ||
    new Set(models).size !== models.length
  )
    throw new ModelSettingsError('提供商和模型名称不能为空，模型不能重复且最多 50 个');
  /** 当前实时连接状态。 */
  const connection = resolveProviderConnection(db, userId, { ...input, providerId: id });
  return transaction(db, () => {
    /** model_providers 表的查询记录。 */
    const previous = id
      ? db.prepare('SELECT * FROM model_providers WHERE id=? AND user_id=?').get(id, userId)
      : undefined;
    if (id && !previous) throw new ModelSettingsError('提供商不存在', 404);
    /** 当前功能设置。 */
    const settings = getSettings(db, userId);
    if (!id && settings.providers.length >= 20)
      throw new ModelSettingsError('最多配置 20 个提供商');
    if (
      settings.defaultModel &&
      settings.defaultModel.providerId === id &&
      !models.includes(settings.defaultModel.model)
    )
      throw new ModelSettingsError('请先切换全局默认模型，再移除该模型', 409);
    /** 模型提供商标识。 */
    const providerId = id ?? randomUUID();
    /** baseUrl：服务基础地址；apiKey：仅在当前调用或编辑流程中使用的服务密钥；presetId：当前提供商预设标识。 */
    const { baseUrl, apiKey, presetId } = connection;
    db.prepare(
      'INSERT INTO model_providers (id,user_id,name,base_url,api_key,models,updated_at,preset_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,api_key=excluded.api_key,models=excluded.models,updated_at=excluded.updated_at,preset_id=excluded.preset_id',
    ).run(
      providerId,
      userId,
      name,
      baseUrl,
      apiKey,
      JSON.stringify(models),
      formatSystemTime(),
      presetId,
    );
    return { id: providerId };
  });
};
/** 设置全局默认提供商与模型。 */
export const setDefault = (db: DatabaseSync, userId: string, choice: DefaultModel) => {
  if (!getModelConfig(db, userId, choice)) throw new ModelSettingsError('提供商或模型不存在', 404);
  db.prepare(
    'INSERT INTO model_defaults VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET provider_id=excluded.provider_id,model=excluded.model',
  ).run(userId, choice.providerId, choice.model);
};
/** 删除指定提供商并检查默认模型约束。 */
export const deleteProvider = (db: DatabaseSync, userId: string, id: string) => {
  /** 当前功能设置。 */
  const settings = getSettings(db, userId);
  if (!settings.providers.some((provider) => provider.id === id))
    throw new ModelSettingsError('提供商不存在', 404);
  if (settings.defaultModel?.providerId === id)
    throw new ModelSettingsError('请先切换全局默认模型，再删除该提供商', 409);
  db.prepare('DELETE FROM model_providers WHERE id=? AND user_id=?').run(id, userId);
};
