import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DefaultModel, ModelProvider, ModelSettings } from '@mlclaw/shared';
import type { ModelConfig } from '../providers/types.js';
import { transaction } from '../db/index.js';

export class ModelSettingsError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export interface ProviderInput { name: string; baseUrl: string; models: string[]; apiKey?: string }
export function getSettings(db: DatabaseSync, userId: string): ModelSettings {
  const providers: ModelProvider[] = db.prepare('SELECT id,name,base_url,models,length(api_key)>0 AS has_key FROM model_providers WHERE user_id=? ORDER BY rowid').all(userId).map(row => ({
    id: String(row.id), name: String(row.name), baseUrl: String(row.base_url), models: JSON.parse(String(row.models)) as string[], hasApiKey: Boolean(row.has_key),
  }));
  const row = db.prepare('SELECT provider_id,model FROM model_defaults WHERE user_id=?').get(userId);
  return { providers, defaultModel: row ? { providerId: String(row.provider_id), model: String(row.model) } : null };
}
export function getModelConfig(db: DatabaseSync, userId: string, choice?: DefaultModel): (ModelConfig & { providerId: string; providerName: string }) | undefined {
  const selected = choice ?? getSettings(db, userId).defaultModel;
  if (!selected) return;
  const row = db.prepare('SELECT * FROM model_providers WHERE id=? AND user_id=?').get(selected.providerId, userId);
  if (!row || !(JSON.parse(String(row.models)) as string[]).includes(selected.model)) return;
  return { providerId: String(row.id), providerName: String(row.name), baseUrl: String(row.base_url), model: selected.model, apiKey: String(row.api_key) };
}
export function saveProvider(db: DatabaseSync, userId: string, input: ProviderInput, id?: string) {
  const name = input.name.trim(); const models = input.models.map(model => model.trim());
  if (!name || models.some(model => !model) || new Set(models).size !== models.length) throw new ModelSettingsError('提供商和模型名称不能为空，同一提供商内的模型不能重复');
  let url: URL;
  try { url = new URL(input.baseUrl); } catch { throw new ModelSettingsError('模型服务地址无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new ModelSettingsError('模型地址须使用 HTTPS；仅本机允许 HTTP，禁止 URL 凭据、查询和片段');
  return transaction(db, () => {
    const previous = id ? db.prepare('SELECT * FROM model_providers WHERE id=? AND user_id=?').get(id, userId) : undefined;
    if (id && !previous) throw new ModelSettingsError('提供商不存在', 404);
    const settings = getSettings(db, userId);
    if (!id && settings.providers.length >= 20) throw new ModelSettingsError('最多配置 20 个提供商');
    if (settings.defaultModel && settings.defaultModel.providerId === id && !models.includes(settings.defaultModel.model)) throw new ModelSettingsError('请先切换全局默认模型，再移除该模型', 409);
    const providerId = id ?? randomUUID(); const baseUrl = url.href.replace(/\/$/, '');
    // 地址改变时绝不复用旧密钥；显式空字符串用于清除密钥。
    const apiKey = input.apiKey ?? (previous?.base_url === baseUrl ? String(previous.api_key) : '');
    db.prepare('INSERT INTO model_providers VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,api_key=excluded.api_key,models=excluded.models,updated_at=excluded.updated_at').run(providerId, userId, name, baseUrl, apiKey, JSON.stringify(models), formatSystemTime());
    return { id: providerId };
  });
}
export function setDefault(db: DatabaseSync, userId: string, choice: DefaultModel) {
  if (!getModelConfig(db, userId, choice)) throw new ModelSettingsError('提供商或模型不存在', 404);
  db.prepare('INSERT INTO model_defaults VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET provider_id=excluded.provider_id,model=excluded.model').run(userId, choice.providerId, choice.model);
}
export function deleteProvider(db: DatabaseSync, userId: string, id: string) {
  const settings = getSettings(db, userId);
  if (!settings.providers.some(provider => provider.id === id)) throw new ModelSettingsError('提供商不存在', 404);
  if (settings.defaultModel?.providerId === id) throw new ModelSettingsError('请先切换全局默认模型，再删除该提供商', 409);
  db.prepare('DELETE FROM model_providers WHERE id=? AND user_id=?').run(id, userId);
}
