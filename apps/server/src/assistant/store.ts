import { formatSystemTime } from '../time.js';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantConfig, AssistantSettings } from '@mlclaw/shared';
import { transaction } from '../db/index.js';
import { AssistantError, defaultAssistant, parseAssistant } from './config.js';

export function getAssistant(db: DatabaseSync, userId: string): AssistantSettings {
  const row = db.prepare('SELECT config,version FROM assistant_configs WHERE user_id=?').get(userId);
  return row ? { config: parseAssistant(JSON.parse(String(row.config))), version: Number(row.version) } : { config: defaultAssistant(), version: 0 };
}
export function saveAssistant(db: DatabaseSync, userId: string, config: AssistantConfig, version: number): AssistantSettings {
  const validated = parseAssistant(config);
  return transaction(db, () => {
    const current = getAssistant(db, userId);
    if (current.version !== version) throw new AssistantError('配置已在其他页面更新，请重新加载后合并修改', 409);
    const next = version + 1;
    db.prepare('INSERT INTO assistant_configs (user_id,config,version,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET config=excluded.config,version=excluded.version,updated_at=excluded.updated_at').run(userId, JSON.stringify(validated), next, formatSystemTime());
    return { config: validated, version: next };
  });
}
