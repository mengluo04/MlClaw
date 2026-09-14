import type { FastifyBaseLogger } from 'fastify';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { formatSystemTime, parseSystemTime } from '../time.js';
import {
  SystemLogError,
  systemLogEntityTypes,
  systemLogLevels,
  systemLogSources,
  type SystemLogInput,
} from './types.js';

/** 允许写入系统日志的元数据字段白名单。 */
const metadataKeys = new Set([
  'attempt',
  'channelKind',
  'durationMs',
  'statusCode',
  'status',
  'reason',
  'count',
  'kind',
  'operation',
  'provider',
  'model',
  'toolName',
  'scheduledAt',
  'retentionDays',
  'logLevel',
]);
/** 系统日志事件标识的格式约束。 */
const eventPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;
/** 提取或规范化文本内容。 */
const text = (value: unknown, limit: number) =>
  String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, limit);

/** 仅保留允许的系统日志元数据并过滤敏感内容。 */
const safeMetadata = (input?: SystemLogInput['metadata']) => {
  if (!input) return null;
  /** 本次处理结果。 */
  const result: Record<string, string | number | boolean | null> = {};
  for (/* 逐项处理当前索引或字段键、当前处理的值。 */ const [key, value] of Object.entries(input)) {
    if (
      !metadataKeys.has(key) ||
      (!['string', 'number', 'boolean'].includes(typeof value) && value !== null)
    )
      continue;
    result[key] = typeof value === 'string' ? text(value, 200) : value;
  }
  /** 序列化后的内容。 */
  const serialized = JSON.stringify(result);
  return serialized.length <= 4096 ? serialized : JSON.stringify({ truncated: true });
};

export class SystemLogService {
  /** 是否正在执行清理，避免重复进入。 */
  private cleaning = false;
  /** 各用户日志等级的缓存。 */
  private levels = new Map<string, 'info' | 'warn' | 'error'>();
  constructor(
    readonly db: DatabaseSync,
    private logger?: FastifyBaseLogger,
  ) {
    for (/* 逐项处理当前数据库记录。 */ const row of db
      .prepare('SELECT user_id,log_level FROM system_log_settings')
      .all()) {
      /** 当前日志等级。 */
      const level = row.log_level as 'info' | 'warn' | 'error';
      this.levels.set(String(row.user_id), level);
      if (this.logger) this.logger.level = level;
    }
  }

  /** 按当前等级过滤、脱敏并持久化系统活动，日志故障不影响业务。 */
  record(userId: string, input: SystemLogInput) {
    /** 当前日志等级。 */
    const level = systemLogLevels.includes(input.level) ? input.level : 'error';
    /** 用于比较日志等级或结果优先级的数值映射。 */
    const ranks = { info: 0, warning: 1, warn: 1, error: 2 };
    if (ranks[level] < ranks[this.levels.get(userId) ?? 'info']) return;
    /** 当前操作的数据来源或源对象。 */
    const source = systemLogSources.includes(input.source) ? input.source : 'system';
    /** 当前处理的事件。 */
    const event = eventPattern.test(input.event) ? input.event : 'system.invalid_event';
    /** 当前消息或提示内容。 */
    const message = text(input.message, 500) || '后台活动';
    /** 日志关联的业务对象类型与标识。 */
    const entity =
      input.entity && systemLogEntityTypes.includes(input.entity.type) && input.entity.id
        ? { type: input.entity.type, id: text(input.entity.id, 100) }
        : undefined;
    /** 用于结构化记录的元数据。 */
    const metadata = safeMetadata(input.metadata);
    /** 当前执行或模型上下文。 */
    const context = {
      source,
      event,
      entityType: entity?.type,
      entityId: entity?.id,
      metadata: metadata ? (JSON.parse(metadata) as unknown) : undefined,
    };
    try {
      this.db
        .prepare(
          'INSERT INTO system_logs(user_id,level,source,event,message,entity_type,entity_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          userId,
          level,
          source,
          event,
          message,
          entity?.type ?? null,
          entity?.id ?? null,
          metadata,
          formatSystemTime(),
        );
      /** HTTP 请求方法。 */
      const method = level === 'warning' ? 'warn' : level;
      this.logger?.[method](context, message);
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      this.logger?.error(
        { source: 'system', event: 'system_log.write_failed', err: error },
        '系统日志写入失败',
      );
    }
  }

  /** 向所有相关用户记录系统活动。 */
  recordAll(input: SystemLogInput) {
    for (/* 逐项处理当前数据库记录。 */ const row of this.db.prepare('SELECT id FROM users').all())
      this.record(String(row.id), input);
  }

  /** 合并短时间内重复出现的系统活动。 */
  recordThrottled(userId: string, input: SystemLogInput, intervalMs = 300000) {
    try {
      /** system_logs 表的查询记录。 */
      const latest = this.db
        .prepare(
          'SELECT created_at FROM system_logs WHERE user_id=? AND event=? ORDER BY id DESC LIMIT 1',
        )
        .get(userId, input.event);
      if (latest && Date.now() - parseSystemTime(String(latest.created_at)) < intervalMs) return;
    } catch {
      /* record() 统一执行标准输出降级。 */
    }
    this.record(userId, input);
  }

  /** 限频记录面向所有相关用户的系统活动。 */
  recordAllThrottled(input: SystemLogInput, intervalMs = 300000) {
    for (/* 逐项处理当前数据库记录。 */ const row of this.db.prepare('SELECT id FROM users').all())
      this.recordThrottled(String(row.id), input, intervalMs);
  }

  /** 读取或更新当前设置。 */
  settings(userId: string) {
    this.db
      .prepare(
        'INSERT INTO system_log_settings(user_id,retention_days,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO NOTHING',
      )
      .run(userId, 7, 1, formatSystemTime());
    /** system_log_settings 表的查询记录。 */
    const row = this.db
      .prepare(
        'SELECT retention_days,log_level,version,updated_at FROM system_log_settings WHERE user_id=?',
      )
      .get(userId)!;
    return {
      retentionDays: Number(row.retention_days),
      logLevel: row.log_level as 'info' | 'warn' | 'error',
      version: Number(row.version),
      updatedAt: String(row.updated_at),
    };
  }

  /** 保存并应用系统日志设置。 */
  updateSettings(
    userId: string,
    retentionDays: number,
    expectedVersion: number,
    logLevel?: 'info' | 'warn' | 'error',
  ) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30)
      throw new SystemLogError('日志保留天数必须为 1–30 天');
    /** 当前有效数据。 */
    const current = this.settings(userId);
    logLevel ??= current.logLevel;
    if (!['info', 'warn', 'error'].includes(logLevel)) throw new SystemLogError('日志等级无效');
    if (current.version !== expectedVersion)
      throw new SystemLogError('日志设置已被其他页面更新，请刷新后重试', 409);
    /** 当前时间。 */
    const now = formatSystemTime();
    this.db
      .prepare(
        'UPDATE system_log_settings SET retention_days=?,log_level=?,version=version+1,updated_at=? WHERE user_id=? AND version=?',
      )
      .run(retentionDays, logLevel, now, userId, expectedVersion);
    this.levels.set(userId, logLevel);
    if (this.logger) this.logger.level = logLevel;
    this.cleanup(userId);
    this.record(userId, {
      level: 'info',
      source: 'system',
      event: 'system.log_settings_updated',
      message: `系统日志设置已更新：保留 ${retentionDays} 天，记录等级 ${logLevel}`,
      metadata: { retentionDays, logLevel },
    });
    return this.settings(userId);
  }

  /** 读取一页记录。 */
  page(userId: string, options: { before?: number; level?: string; source?: string }) {
    /** 拼接查询语句使用的筛选条件。 */
    const conditions = ['user_id=?', 'id<?'];
    /** 当前请求参数。 */
    const params: SQLInputValue[] = [userId, options.before ?? Number.MAX_SAFE_INTEGER];
    if (options.level) {
      conditions.push('level=?');
      params.push(options.level);
    }
    if (options.source) {
      conditions.push('source=?');
      params.push(options.source);
    }
    /** system_logs 表的查询记录集合。 */
    const rows = this.db
      .prepare(
        `SELECT * FROM system_logs WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 51`,
      )
      .all(...params);
    /** 最近已知事件标识，用于实时订阅续传。 */
    const latestId = Number(
      this.db
        .prepare('SELECT COALESCE(MAX(id),0) AS id FROM system_logs WHERE user_id=?')
        .get(userId)!.id,
    );
    return {
      items: rows.slice(0, 50).map(systemLogView),
      nextCursor: rows.length > 50 ? String(rows[49]!.id) : null,
      latestId,
    };
  }

  /** 读取指定游标之后的记录。 */
  after(userId: string, cursor: number) {
    return this.db
      .prepare('SELECT * FROM system_logs WHERE user_id=? AND id>? ORDER BY id LIMIT 100')
      .all(userId, cursor)
      .map(systemLogView);
  }

  /** 计算本次读取或查询的范围。 */
  bounds(userId: string) {
    /** system_logs 表的查询记录。 */
    const row = this.db
      .prepare('SELECT MIN(id) AS oldest,MAX(id) AS latest FROM system_logs WHERE user_id=?')
      .get(userId)!;
    return {
      oldest: row.oldest === null ? 0 : Number(row.oldest),
      latest: row.latest === null ? 0 : Number(row.latest),
    };
  }

  /** 按保留天数和记录数上限清理日志，防止重复进入。 */
  cleanup(userId?: string) {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      /** 用户记录集合。 */
      const users = userId ? [{ id: userId }] : this.db.prepare('SELECT id FROM users').all();
      for (/* 逐项处理当前数据库记录。 */ const row of users) {
        /** 当前记录标识。 */
        const id = String(row.id);
        /** 当前用户配置的日志保留天数。 */
        const days = this.settings(id).retentionDays;
        /** 用于淘汰过期记录的时间边界。 */
        const cutoff = formatSystemTime(new Date(Date.now() - days * 86400000));
        while (
          Number(
            this.db
              .prepare('SELECT COUNT(*) AS n FROM system_logs WHERE user_id=? AND created_at<?')
              .get(id, cutoff)!.n,
          )
        ) {
          this.db
            .prepare(
              'DELETE FROM system_logs WHERE id IN (SELECT id FROM system_logs WHERE user_id=? AND created_at<? ORDER BY id LIMIT 1000)',
            )
            .run(id, cutoff);
        }
        while (
          Number(
            this.db.prepare('SELECT COUNT(*) AS n FROM system_logs WHERE user_id=?').get(id)!.n,
          ) > 20000
        ) {
          this.db
            .prepare(
              'DELETE FROM system_logs WHERE id IN (SELECT id FROM system_logs WHERE user_id=? ORDER BY id LIMIT 1000)',
            )
            .run(id);
        }
      }
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      this.logger?.error(
        { source: 'system', event: 'system_log.cleanup_failed', err: error },
        '系统日志清理失败',
      );
    } finally {
      this.cleaning = false;
    }
  }
}

/** 将日志数据库记录转换为公开结构。 */
export const systemLogView = (row: Record<string, unknown>) => {
  /** 用于结构化记录的元数据。 */
  let metadata: Record<string, unknown> | null = null;
  try {
    metadata =
      row.metadata === null ? null : (JSON.parse(String(row.metadata)) as Record<string, unknown>);
  } catch {
    metadata = null;
  }
  return {
    id: Number(row.id),
    level: String(row.level),
    source: String(row.source),
    event: String(row.event),
    message: String(row.message),
    entityType: row.entity_type === null ? null : String(row.entity_type),
    entityId: row.entity_id === null ? null : String(row.entity_id),
    metadata,
    createdAt: String(row.created_at),
  };
};
