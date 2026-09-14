/** 系统日志允许使用的事件等级。 */
export const systemLogLevels = ['info', 'warning', 'error'] as const;
export type SystemLogLevel = (typeof systemLogLevels)[number];

/** 系统日志允许使用的来源分类。 */
export const systemLogSources = [
  'system',
  'auth',
  'task',
  'schedule',
  'channel',
  'model',
  'web',
  'executor',
  'storage',
] as const;
export type SystemLogSource = (typeof systemLogSources)[number];

/** 系统日志允许关联的业务对象类型。 */
export const systemLogEntityTypes = ['task', 'schedule', 'occurrence', 'channel', 'tool'] as const;
export type SystemLogEntityType = (typeof systemLogEntityTypes)[number];

export interface SystemLogInput {
  level: SystemLogLevel;
  source: SystemLogSource;
  event: string;
  message: string;
  entity?: { type: SystemLogEntityType; id: string };
  metadata?: Record<string, string | number | boolean | null>;
}

export class SystemLogError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
