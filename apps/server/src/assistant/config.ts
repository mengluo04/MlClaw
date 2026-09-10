import type { AssistantConfig } from '@mlclaw/shared';
import { record } from '../providers/types.js';

export class AssistantError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export function defaultAssistant(): AssistantConfig {
  return { name: 'MlClaw', emoji: '🤖', description: '个人 AI 助手', personality: '使用清晰、自然的语言回答，先给结论。', userName: '', language: '中文', timezone: 'Asia/Shanghai', userBackground: '', toolNotes: '', rules: [], onboardingCompleted: false };
}
const limits = { name: 80, emoji: 32, description: 1000, personality: 3000, userName: 80, language: 80, timezone: 100, userBackground: 3000, toolNotes: 2000 };
export function parseAssistant(value: unknown): AssistantConfig {
  if (!record(value) || Object.keys(value).some(key => !Object.hasOwn(limits, key) && !['rules', 'onboardingCompleted'].includes(key))) throw new AssistantError('助手配置字段无效');
  const fields: Record<string, string> = {};
  for (const [key, limit] of Object.entries(limits)) {
    const field = value[key];
    if (typeof field !== 'string' || field.length > limit || field.includes('\0')) throw new AssistantError(`${key} 必须为不超过 ${limit} 字符的文本`);
    fields[key] = field.trim();
  }
  if (!fields.name || !fields.language || !fields.timezone) throw new AssistantError('助手名称、语言和时区不能为空');
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: fields.timezone }); } catch { throw new AssistantError('时区无效，请使用 Asia/Shanghai 等时区名称'); }
  if (!Array.isArray(value.rules) || value.rules.length > 30) throw new AssistantError('行为规则最多 30 条');
  const ids = new Set<string>();
  const rules = value.rules.map((rule: unknown) => {
    if (!record(rule) || Object.keys(rule).some(key => !['id', 'content', 'enabled'].includes(key)) || typeof rule.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(rule.id) || ids.has(rule.id) || typeof rule.content !== 'string' || !rule.content.trim() || rule.content.length > 2000 || rule.content.includes('\0') || typeof rule.enabled !== 'boolean') throw new AssistantError('规则需包含唯一 ID、1–2000 字符内容及启用状态');
    ids.add(rule.id); return { id: rule.id, content: rule.content.trim(), enabled: rule.enabled };
  });
  if (typeof value.onboardingCompleted !== 'boolean') throw new AssistantError('首次设置状态无效');
  const config: AssistantConfig = { name: fields.name!, emoji: fields.emoji!, description: fields.description!, personality: fields.personality!, userName: fields.userName!, language: fields.language!, timezone: fields.timezone!, userBackground: fields.userBackground!, toolNotes: fields.toolNotes!, rules, onboardingCompleted: value.onboardingCompleted };
  if (JSON.stringify(config).length > 12000) throw new AssistantError('助手配置总量超过 12000 字符，请精简后保存');
  return config;
}
export function expectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AssistantError('配置版本无效');
  return value;
}
