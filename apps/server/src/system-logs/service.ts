import type { FastifyBaseLogger } from 'fastify';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { formatSystemTime, parseSystemTime } from '../time.js';
import { SystemLogError, systemLogEntityTypes, systemLogLevels, systemLogSources, type SystemLogInput } from './types.js';

const metadataKeys = new Set([
  'attempt', 'channelKind', 'durationMs', 'statusCode', 'status', 'reason', 'count',
  'kind', 'operation', 'provider', 'model', 'toolName', 'scheduledAt', 'retentionDays',
]);
const eventPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;
const text = (value: unknown, limit: number) => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);

function safeMetadata(input?: SystemLogInput['metadata']) {
  if (!input) return null;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!metadataKeys.has(key) || !['string', 'number', 'boolean'].includes(typeof value) && value !== null) continue;
    result[key] = typeof value === 'string' ? text(value, 200) : value;
  }
  const serialized = JSON.stringify(result);
  return serialized.length <= 4096 ? serialized : JSON.stringify({ truncated: true });
}

export class SystemLogService {
  private cleaning = false;
  constructor(readonly db: DatabaseSync, private logger?: FastifyBaseLogger) {}

  record(userId: string, input: SystemLogInput) {
    const level = systemLogLevels.includes(input.level) ? input.level : 'error';
    const source = systemLogSources.includes(input.source) ? input.source : 'system';
    const event = eventPattern.test(input.event) ? input.event : 'system.invalid_event';
    const message = text(input.message, 500) || '后台活动';
    const entity = input.entity && systemLogEntityTypes.includes(input.entity.type) && input.entity.id
      ? { type: input.entity.type, id: text(input.entity.id, 100) } : undefined;
    const metadata = safeMetadata(input.metadata);
    const context = { source, event, entityType: entity?.type, entityId: entity?.id, metadata: metadata ? JSON.parse(metadata) as unknown : undefined };
    try {
      this.db.prepare('INSERT INTO system_logs(user_id,level,source,event,message,entity_type,entity_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(userId, level, source, event, message, entity?.type ?? null, entity?.id ?? null, metadata, formatSystemTime());
      const method = level === 'warning' ? 'warn' : level;
      this.logger?.[method](context, message);
    } catch (error) {
      this.logger?.error({ source: 'system', event: 'system_log.write_failed', err: error }, '系统日志写入失败');
    }
  }

  recordAll(input: SystemLogInput) {
    for (const row of this.db.prepare('SELECT id FROM users').all()) this.record(String(row.id), input);
  }

  recordThrottled(userId: string, input: SystemLogInput, intervalMs = 300000) {
    try {
      const latest = this.db.prepare('SELECT created_at FROM system_logs WHERE user_id=? AND event=? ORDER BY id DESC LIMIT 1').get(userId, input.event);
      if (latest && Date.now() - parseSystemTime(String(latest.created_at)) < intervalMs) return;
    } catch { /* record() 统一执行标准输出降级。 */ }
    this.record(userId, input);
  }

  recordAllThrottled(input: SystemLogInput, intervalMs = 300000) {
    for (const row of this.db.prepare('SELECT id FROM users').all()) this.recordThrottled(String(row.id), input, intervalMs);
  }

  settings(userId: string) {
    this.db.prepare('INSERT INTO system_log_settings(user_id,retention_days,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO NOTHING')
      .run(userId, 7, 1, formatSystemTime());
    const row = this.db.prepare('SELECT retention_days,version,updated_at FROM system_log_settings WHERE user_id=?').get(userId)!;
    return { retentionDays: Number(row.retention_days), version: Number(row.version), updatedAt: String(row.updated_at) };
  }

  updateSettings(userId: string, retentionDays: number, expectedVersion: number) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30) throw new SystemLogError('日志保留天数必须为 1–30 天');
    const current = this.settings(userId);
    if (current.version !== expectedVersion) throw new SystemLogError('日志设置已被其他页面更新，请刷新后重试', 409);
    const now = formatSystemTime();
    this.db.prepare('UPDATE system_log_settings SET retention_days=?,version=version+1,updated_at=? WHERE user_id=? AND version=?')
      .run(retentionDays, now, userId, expectedVersion);
    this.cleanup(userId);
    this.record(userId, { level: 'info', source: 'system', event: 'system.retention_updated', message: `系统日志保留时间已调整为 ${retentionDays} 天`, metadata: { retentionDays } });
    return this.settings(userId);
  }

  page(userId: string, options: { before?: number; level?: string; source?: string }) {
    const conditions = ['user_id=?', 'id<?'];
    const params: SQLInputValue[] = [userId, options.before ?? Number.MAX_SAFE_INTEGER];
    if (options.level) { conditions.push('level=?'); params.push(options.level); }
    if (options.source) { conditions.push('source=?'); params.push(options.source); }
    const rows = this.db.prepare(`SELECT * FROM system_logs WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 51`).all(...params);
    const latestId = Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM system_logs WHERE user_id=?').get(userId)!.id);
    return { items: rows.slice(0, 50).map(systemLogView), nextCursor: rows.length > 50 ? String(rows[49]!.id) : null, latestId };
  }

  after(userId: string, cursor: number) {
    return this.db.prepare('SELECT * FROM system_logs WHERE user_id=? AND id>? ORDER BY id LIMIT 100').all(userId, cursor).map(systemLogView);
  }

  bounds(userId: string) {
    const row = this.db.prepare('SELECT MIN(id) AS oldest,MAX(id) AS latest FROM system_logs WHERE user_id=?').get(userId)!;
    return { oldest: row.oldest === null ? 0 : Number(row.oldest), latest: row.latest === null ? 0 : Number(row.latest) };
  }

  cleanup(userId?: string) {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      const users = userId ? [{ id: userId }] : this.db.prepare('SELECT id FROM users').all();
      for (const row of users) {
        const id = String(row.id); const days = this.settings(id).retentionDays;
        const cutoff = formatSystemTime(new Date(Date.now() - days * 86400000));
        while (Number(this.db.prepare('SELECT COUNT(*) AS n FROM system_logs WHERE user_id=? AND created_at<?').get(id, cutoff)!.n)) {
          this.db.prepare('DELETE FROM system_logs WHERE id IN (SELECT id FROM system_logs WHERE user_id=? AND created_at<? ORDER BY id LIMIT 1000)').run(id, cutoff);
        }
        while (Number(this.db.prepare('SELECT COUNT(*) AS n FROM system_logs WHERE user_id=?').get(id)!.n) > 20000) {
          this.db.prepare('DELETE FROM system_logs WHERE id IN (SELECT id FROM system_logs WHERE user_id=? ORDER BY id LIMIT 1000)').run(id);
        }
      }
    } catch (error) {
      this.logger?.error({ source: 'system', event: 'system_log.cleanup_failed', err: error }, '系统日志清理失败');
    } finally { this.cleaning = false; }
  }
}

export function systemLogView(row: Record<string, unknown>) {
  let metadata: Record<string, unknown> | null = null;
  try { metadata = row.metadata === null ? null : JSON.parse(String(row.metadata)) as Record<string, unknown>; } catch { metadata = null; }
  return {
    id: Number(row.id), level: String(row.level), source: String(row.source), event: String(row.event), message: String(row.message),
    entityType: row.entity_type === null ? null : String(row.entity_type), entityId: row.entity_id === null ? null : String(row.entity_id),
    metadata, createdAt: String(row.created_at),
  };
}
