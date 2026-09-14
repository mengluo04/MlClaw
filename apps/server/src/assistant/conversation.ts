import { formatSystemTime } from '../time.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ConversationRules } from '@mlclaw/shared';
import { transaction } from '../db/index.js';
import { AssistantError, expectedVersion } from './config.js';

/** 读取当前用户会话的补充规则。 */
export const getConversationRules = (
  db: DatabaseSync,
  userId: string,
  conversationId: string,
): ConversationRules => {
  if (
    !db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId)
  )
    throw new AssistantError('会话不存在', 404);
  /** conversation_rules 表的查询记录。 */
  const row = db
    .prepare('SELECT content,version FROM conversation_rules WHERE conversation_id=?')
    .get(conversationId);
  return row
    ? { content: String(row.content), version: Number(row.version) }
    : { content: '', version: 0 };
};
/** 校验会话补充规则内容与长度。 */
export const parseConversationContent = (content: unknown): string => {
  if (typeof content !== 'string' || content.length > 4000 || content.includes('\0'))
    throw new AssistantError('会话规则必须为不超过 4000 字符的文本');
  return content.trim();
};
/** 校验归属与版本后保存会话补充规则。 */
export const saveConversationRules = (
  db: DatabaseSync,
  userId: string,
  conversationId: string,
  input: unknown,
  version: unknown,
): ConversationRules => {
  /** 当前记录的正文内容。 */
  const content = parseConversationContent(input);
  /** 测试或校验使用的预期值。 */
  const expected = expectedVersion(version);
  return transaction(db, () => {
    /** 当前有效数据。 */
    const current = getConversationRules(db, userId, conversationId);
    if (current.version !== expected)
      throw new AssistantError('会话规则已更新，请重新加载后合并修改', 409);
    db.prepare(
      'INSERT INTO conversation_rules (conversation_id,content,version,updated_at) VALUES (?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET content=excluded.content,version=excluded.version,updated_at=excluded.updated_at',
    ).run(conversationId, content, expected + 1, formatSystemTime());
    return { content, version: expected + 1 };
  });
};
