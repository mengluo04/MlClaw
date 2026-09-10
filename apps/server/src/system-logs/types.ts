export const systemLogLevels = ['info', 'warning', 'error'] as const;
export type SystemLogLevel = typeof systemLogLevels[number];

export const systemLogSources = ['system', 'auth', 'task', 'schedule', 'channel', 'model', 'web', 'executor', 'storage'] as const;
export type SystemLogSource = typeof systemLogSources[number];

export const systemLogEntityTypes = ['task', 'schedule', 'occurrence', 'channel', 'tool'] as const;
export type SystemLogEntityType = typeof systemLogEntityTypes[number];

export interface SystemLogInput {
  level: SystemLogLevel;
  source: SystemLogSource;
  event: string;
  message: string;
  entity?: { type: SystemLogEntityType; id: string };
  metadata?: Record<string, string | number | boolean | null>;
}

export class SystemLogError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
