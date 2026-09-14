import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantAvatarSettings } from '@mlclaw/shared';
import { formatSystemTime } from '../time.js';

/** 默认机器人头像，与网站墨绿色配色保持一致。 */
export const defaultAssistantAvatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <title>AI 助手头像</title>
  <rect width="64" height="64" rx="20" fill="#39766b"/>
  <path d="M32 14v7" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
  <circle cx="32" cy="12" r="4" fill="#c7dcd7"/>
  <rect x="13" y="22" width="38" height="29" rx="11" fill="#fff"/>
  <rect x="21" y="30" width="6" height="8" rx="3" fill="#39766b"/>
  <rect x="37" y="30" width="6" height="8" rx="3" fill="#39766b"/>
  <path d="M27 43c3 3 7 3 10 0" stroke="#39766b" stroke-width="3" stroke-linecap="round"/>
</svg>`;

/** 仅读取当前用户的头像元信息。 */
export const getAssistantAvatarSettings = (
  db: DatabaseSync,
  userId: string,
): AssistantAvatarSettings => {
  const row = db.prepare('SELECT version FROM assistant_avatars WHERE user_id=?').get(userId);
  return {
    custom: !!row,
    url: row ? `/api/assistant-avatar?v=${String(row.version)}` : '/api/assistant-avatar',
  };
};

/** 原子替换头像；独立于网站图标和模型身份配置。 */
export const saveAssistantAvatar = (db: DatabaseSync, userId: string, image: Buffer) => {
  db.prepare(
    `INSERT INTO assistant_avatars(user_id,image,version,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET image=excluded.image,version=excluded.version,updated_at=excluded.updated_at`,
  ).run(userId, image, randomUUID(), formatSystemTime());
  return getAssistantAvatarSettings(db, userId);
};
