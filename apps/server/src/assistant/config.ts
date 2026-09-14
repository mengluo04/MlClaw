import type { AssistantConfig } from '@mlclaw/shared';
import { record } from '../providers/types.js';

export class AssistantError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
/** 创建默认的空白助手配置。 */
export const defaultAssistant = (): AssistantConfig => {
  return {
    name: '',
    emoji: '',
    description: '',
    personality: '',
    userName: '',
    language: '',
    timezone: '',
    userBackground: '',
    toolNotes: '',
    rules: [],
    onboardingCompleted: false,
  };
};
/** 当前功能的限制配置。 */
const limits = {
  name: 80,
  emoji: 32,
  description: 1000,
  personality: 3000,
  userName: 80,
  language: 80,
  timezone: 100,
  userBackground: 3000,
  toolNotes: 2000,
};
/** 运行时校验并规范化助手配置。 */
export const parseAssistant = (value: unknown): AssistantConfig => {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !Object.hasOwn(limits, key) && !['rules', 'onboardingCompleted'].includes(key),
    )
  )
    throw new AssistantError('助手配置字段无效');
  /** 需要处理的数据库或对象字段集合。 */
  const fields: Record<string, string> = {};
  for (/* 逐项处理当前索引或字段键、当前处理上限。 */ const [key, limit] of Object.entries(
    limits,
  )) {
    /** 当前处理的数据库或对象字段。 */
    const field = value[key];
    if (typeof field !== 'string' || field.length > limit || field.includes('\0'))
      throw new AssistantError(`${key} 必须为不超过 ${limit} 字符的文本`);
    fields[key] = field.trim();
  }
  if (value.onboardingCompleted && (!fields.name || !fields.language || !fields.timezone))
    throw new AssistantError('助手名称、语言和时区不能为空');
  if (fields.timezone) {
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: fields.timezone });
    } catch {
      throw new AssistantError('时区无效，请使用 Asia/Shanghai 等时区名称');
    }
  }
  if (!Array.isArray(value.rules) || value.rules.length > 30)
    throw new AssistantError('行为规则最多 30 条');
  /** 待处理记录标识集合。 */
  const ids = new Set<string>();
  /** 当前规则列表。 */
  const rules = value.rules.map((rule: unknown) => {
    if (
      !record(rule) ||
      Object.keys(rule).some((key) => !['id', 'content', 'enabled'].includes(key)) ||
      typeof rule.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(rule.id) ||
      ids.has(rule.id) ||
      typeof rule.content !== 'string' ||
      !rule.content.trim() ||
      rule.content.length > 2000 ||
      rule.content.includes('\0') ||
      typeof rule.enabled !== 'boolean'
    )
      throw new AssistantError('规则需包含唯一 ID、1–2000 字符内容及启用状态');
    ids.add(rule.id);
    return { id: rule.id, content: rule.content.trim(), enabled: rule.enabled };
  });
  if (typeof value.onboardingCompleted !== 'boolean') throw new AssistantError('首次设置状态无效');
  /** 当前流程使用的配置。 */
  const config: AssistantConfig = {
    name: fields.name!,
    emoji: fields.emoji!,
    description: fields.description!,
    personality: fields.personality!,
    userName: fields.userName!,
    language: fields.language!,
    timezone: fields.timezone!,
    userBackground: fields.userBackground!,
    toolNotes: fields.toolNotes!,
    rules,
    onboardingCompleted: value.onboardingCompleted,
  };
  if (JSON.stringify(config).length > 12000)
    throw new AssistantError('助手配置总量超过 12000 字符，请精简后保存');
  return config;
};
/** 校验用于并发修改检测的版本号。 */
export const expectedVersion = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AssistantError('配置版本无效');
  return value;
};
