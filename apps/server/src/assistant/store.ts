import { formatSystemTime } from '../time.js';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantConfig, AssistantSettings } from '@mlclaw/shared';
import { transaction } from '../db/index.js';
import { AssistantError, defaultAssistant, parseAssistant } from './config.js';

/** 读取当前用户的助手配置。 */
export const getAssistant = (db: DatabaseSync, userId: string): AssistantSettings => {
  /** assistant_configs 表的查询记录。 */
  const row = db
    .prepare('SELECT config,version FROM assistant_configs WHERE user_id=?')
    .get(userId);
  return row
    ? { config: parseAssistant(JSON.parse(String(row.config))), version: Number(row.version) }
    : { config: defaultAssistant(), version: 0 };
};
/** 按预期版本保存助手配置。 */
export const saveAssistant = (
  db: DatabaseSync,
  userId: string,
  config: AssistantConfig,
  version: number,
): AssistantSettings => {
  /** 通过运行时校验的配置内容。 */
  const validated = parseAssistant(config);
  return transaction(db, () => {
    /** 当前有效数据。 */
    const current = getAssistant(db, userId);
    if (current.version !== version)
      throw new AssistantError('配置已在其他页面更新，请重新加载后合并修改', 409);
    /** 下一次处理使用的数据。 */
    const next = version + 1;
    db.prepare(
      'INSERT INTO assistant_configs (user_id,config,version,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET config=excluded.config,version=excluded.version,updated_at=excluded.updated_at',
    ).run(userId, JSON.stringify(validated), next, formatSystemTime());
    return { config: validated, version: next };
  });
};
