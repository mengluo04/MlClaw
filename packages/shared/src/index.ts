// 业务日期时间字符串统一为服务器系统本地时间 YYYY-MM-DD HH:mm:ss；不含时区偏移。
export interface HealthResponse {
  status: 'ok';
  application: 'MlClaw';
  applicationId: 'vip.mengluo.mlclaw';
}

export interface Conversation { id: string; title: string; created_at: string }
export interface Message { id: string; role: string; content: string; created_at: string }
export interface ToolRecord { id: string; name: string; arguments: string; arguments_digest: string; status: string; result: string | null; created_at: string; finished_at: string | null }
export interface Task { id: string; kind?: 'chat' | 'summary'; skills?: SkillLoad[]; status: string; input: string; error: string | null; usage: string | null; created_at: string; finished_at: string | null; tools?: ToolRecord[]; model_snapshot: string | null }
export interface TaskEvent { id: number; taskId: string; type: string; data: { text?: string; messageId?: string; status?: string; message?: string }; createdAt: string }
export interface ModelProvider { id: string; name: string; baseUrl: string; models: string[]; hasApiKey: boolean }
export interface DefaultModel { providerId: string; model: string }
export interface ModelSettings { providers: ModelProvider[]; defaultModel: DefaultModel | null }
export interface CommandRequest { id: string; command: string; cwd: string; args: string[]; timeoutMs: number }
export interface CommandResult { status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; stdout: string; stderr: string; exitCode: number | null; reason?: string; durationMs: number }
export interface Memory { id: string; content: string; priority: number; created_at: string; updated_at: string }
export interface FileEntry { name: string; type: string }

export interface AssistantRule { id: string; content: string; enabled: boolean }
export interface AssistantConfig {
  name: string; emoji: string; description: string; personality: string;
  userName: string; language: string; timezone: string; userBackground: string;
  toolNotes: string; rules: AssistantRule[]; onboardingCompleted: boolean;
}
export interface AssistantSettings { config: AssistantConfig; version: number }
export interface ContextSection { source: string; content: string; characters: number }
export interface AssistantPreview {
  sections: ContextSection[];
  budget: { unit: 'characters'; used: number; limit: number; outputReserve: number; toolReserve: number; historyCharacters: number; omittedMessages: number };
}
export interface AssistantTemplate { id: string; name: string; description: string; config: AssistantConfig }
export interface ConversationRules { content: string; version: number }
export type ChannelKind = 'qq' | 'weixin';
export interface ChannelAccountView {
  id: string; kind: ChannelKind; remoteId: string; enabled: boolean; hasCredential: boolean;
  pairedSender: string | null; state: 'stopped' | 'connecting' | 'connected' | 'error' | 'expired'; message: string;
}
export interface ChannelDeliveryView {
  id: string; kind: ChannelKind; status: string; error: string | null; createdAt: string;
  conversationId: string | null; taskId: string | null;
}
export interface ChannelSettings { accounts: ChannelAccountView[]; deliveries: ChannelDeliveryView[] }
export interface WeixinLoginView {
  id: string; state: 'wait' | 'scaned' | 'need_verifycode' | 'confirmed' | 'expired' | 'error';
  qrDataUrl: string; expiresAt: string; message: string;
}

export interface ScheduleInput { name: string; kind: 'reminder' | 'agent'; content: string; cron: string; enabled: boolean; deliveryChannelId?: string | null }
export interface Schedule extends ScheduleInput { id: string; version: number; nextRunAt: string | null; createdAt: string }
export type ScheduleBatchOperation = 'enable' | 'disable' | 'delete';
export interface ScheduleBatchInput { operation: ScheduleBatchOperation; items: Array<{ id: string; expectedVersion: number }> }
export interface ScheduleBatchResult { updated: number }
export interface ScheduleSnapshot extends ScheduleInput { version: number; timezone: string }
export interface ScheduleOccurrence {
  id: string; scheduleId: string; source: 'cron' | 'manual'; scheduledAt: string; snapshot: ScheduleSnapshot;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'interrupted';
  taskId: string | null; conversationId: string | null; reason: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; readAt: string | null;
  delivery?: { kind: ChannelKind; status: string; error: string | null } | null;
}
export interface SchedulePreview { cron: string; timezone: string; nextRuns: string[] }
export interface ScheduleList { schedules: Schedule[]; timezone: string; schedulerError: string | null; unread: number }
export interface ScheduleHistory { occurrences: ScheduleOccurrence[]; nextCursor: number | null }
export interface WebSettings {
  provider: 'tavily'; enabled: boolean; allowFetch: boolean; allowSchedules: boolean;
  hasApiKey: boolean; version: number; updatedAt: string | null;
}
export interface WebSettingsInput {
  provider: 'tavily'; enabled: boolean; allowFetch: boolean; allowSchedules: boolean;
  apiKey?: string; expectedVersion: number;
}
export interface WebConnectionTest { ok: true; durationMs: number; resultCount: number }
export interface MemorySearch { query: string; terms: string[]; items: Memory[]; truncated: boolean }
export interface TaskSearchItem { id: string; conversationId: string; status: string; kind: string; input: string; createdAt: string; finishedAt: string | null }
export interface TaskSearch { query: string; scope: 'current' | 'all'; items: TaskSearchItem[]; truncated: boolean }
export interface TaskEvidence extends TaskSearchItem {
  error: string | null; referenceOnly: true; nextOffset: number | null;
  tools: { id: string; name: string; status: string; result: string | null; truncated: boolean; createdAt: string; finishedAt: string | null }[];
}
export interface ConversationContext {
  autoSummary: boolean; version: number; summary: string; valid: boolean; coveredMessages: number; remainingMessages: number;
  throughMessageId: string | null; throughCursor: number; sourceTruncated: boolean; model: string | null; updatedAt: string | null;
  latestTask: { id: string; status: string; error: string | null } | null;
}
export interface SkillResource { name: string; content: string }
export interface SkillInput { name: string; description: string; keywords: string[]; content: string; enabled: boolean; resources: SkillResource[] }
export interface Skill extends SkillInput { id: string; version: number; accessVersion: number; createdAt: string; updatedAt: string }
export interface SkillMatch { id: string; name: string; description: string; version: number; score: number; source: string; excerpt: string }
export interface SkillSearch { query: string; items: SkillMatch[]; truncated: boolean }
export interface SkillLoad { skillId: string; name: string; version: number; resource: string | null; loadedAt: string }

export type SystemLogLevel = 'info' | 'warning' | 'error';
export type SystemLogSource = 'system' | 'auth' | 'task' | 'schedule' | 'channel' | 'model' | 'web' | 'executor' | 'storage';
export interface SystemLogRecord {
  id: number; level: SystemLogLevel; source: SystemLogSource; event: string; message: string;
  entityType: 'task' | 'schedule' | 'occurrence' | 'channel' | 'tool' | null; entityId: string | null;
  metadata: Record<string, unknown> | null; createdAt: string;
}
export interface SystemLogPage { items: SystemLogRecord[]; nextCursor: string | null; latestId: number }
export interface SystemLogSettings { retentionDays: number; version: number; updatedAt: string }
