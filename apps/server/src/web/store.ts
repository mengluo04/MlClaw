import type { DatabaseSync } from 'node:sqlite';
import type { WebSettings, WebSettingsInput } from '@mlclaw/shared';
import { transaction } from '../db/index.js';
import { formatSystemTime } from '../time.js';
import { WebError } from './types.js';

export interface WebConfig extends WebSettings { apiKey: string }
export function getWebConfig(db: DatabaseSync, userId: string): WebConfig {
  const row = db.prepare('SELECT * FROM web_settings WHERE user_id=?').get(userId);
  if (!row) return { provider: 'tavily', enabled: false, allowFetch: true, allowSchedules: false, apiKey: '', hasApiKey: false, version: 0, updatedAt: null };
  return { provider: 'tavily', enabled: !!row.enabled, allowFetch: !!row.allow_fetch, allowSchedules: !!row.allow_schedules,
    apiKey: String(row.api_key), hasApiKey: !!row.api_key, version: Number(row.version), updatedAt: String(row.updated_at) };
}
export function publicWebConfig(config: WebConfig): WebSettings {
  const { apiKey: _, ...result } = config; return result;
}
export function saveWebConfig(db: DatabaseSync, userId: string, input: WebSettingsInput): WebSettings {
  return transaction(db, () => {
    const previous = getWebConfig(db, userId);
    if (input.expectedVersion !== previous.version) throw new WebError('联网配置已被其他页面更新，请重新加载后再保存；当前草稿已保留', 409);
    const key = input.apiKey === undefined ? previous.apiKey : input.apiKey.trim();
    if (key && /[^\x21-\x7e]/.test(key)) throw new WebError('API Key 只能包含非空白的 ASCII 字符');
    // 清除密钥同时关闭联网，避免留下看似启用但无法工作的配置。
    const enabled = input.apiKey === '' ? false : input.enabled;
    if (enabled && !key) throw new WebError('启用联网搜索前请填写 API Key');
    db.prepare(`INSERT INTO web_settings VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
      provider=excluded.provider,enabled=excluded.enabled,allow_fetch=excluded.allow_fetch,allow_schedules=excluded.allow_schedules,
      api_key=excluded.api_key,version=excluded.version,updated_at=excluded.updated_at`).run(
      userId, input.provider, Number(enabled), Number(input.allowFetch), Number(input.allowSchedules), key, previous.version + 1, formatSystemTime());
    return publicWebConfig(getWebConfig(db, userId));
  });
}
