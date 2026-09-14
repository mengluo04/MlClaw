import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
  Schedule,
  ScheduleBatchInput,
  ScheduleHistory,
  ScheduleInput,
  ScheduleOccurrence,
  ScheduleSnapshot,
} from '@mlclaw/shared';
import { transaction } from '../db/index.js';
import { TaskError } from '../tasks/manager.js';
import { cronPreview } from './cron.js';
import { resolveTarget, type DeliveryTarget } from './delivery.js';
import type { ScheduleCommands, CommandSpec } from './commands.js';

type Row = Record<string, SQLOutputValue>;
/** 将可空值转换为存储或响应格式。 */
const nullable = (value: SQLOutputValue | undefined) => (value == null ? null : String(value));
/** 将数据库计划记录映射为接口结构。 */
export const scheduleView = (row: Row): Schedule => {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as Schedule['kind'],
    ...(row.command_spec
      ? {
          commandOptions: {
            timeoutMs: (JSON.parse(String(row.command_spec)) as CommandSpec).timeoutMs,
          },
        }
      : {}),
    content: String(row.content),
    cron: String(row.cron),
    enabled: !!row.enabled,
    version: Number(row.version),
    nextRunAt: nullable(row.next_run_at),
    createdAt: String(row.created_at),
    deliveryChannelId: row.delivery_target
      ? (JSON.parse(String(row.delivery_target)) as DeliveryTarget).accountId
      : null,
  };
};
/** 将数据库执行实例映射为接口结构。 */
export const occurrenceView = (row: Row): ScheduleOccurrence => {
  return {
    id: String(row.id),
    scheduleId: String(row.schedule_id),
    source: row.source === 'manual' ? 'manual' : 'cron',
    scheduledAt: String(row.scheduled_at),
    snapshot: JSON.parse(String(row.snapshot)) as ScheduleSnapshot,
    status: String(row.status) as ScheduleOccurrence['status'],
    taskId: nullable(row.task_id),
    conversationId: nullable(row.conversation_id),
    reason: nullable(row.reason),
    createdAt: String(row.created_at),
    startedAt: nullable(row.started_at),
    finishedAt: nullable(row.finished_at),
    readAt: nullable(row.read_at),
    commandResult: row.command_result
      ? (JSON.parse(String(row.command_result)) as ScheduleOccurrence['commandResult'])
      : null,
  };
};

export class ScheduleStore {
  constructor(
    readonly db: DatabaseSync,
    readonly timezone: string,
    readonly clock: () => Date,
    readonly commands?: ScheduleCommands,
  ) {}
  /** 读取指定记录。 */
  get(id: string, userId: string) {
    /** schedules 表的查询记录。 */
    const row = this.db
      .prepare('SELECT * FROM schedules WHERE id=? AND user_id=? AND deleted_at IS NULL')
      .get(id, userId);
    if (!row) throw new TaskError('定时计划不存在', 404);
    return scheduleView(row);
  }
  /** 读取并更新当前列表。 */
  list(userId: string) {
    return this.db
      .prepare('SELECT * FROM schedules WHERE user_id=? AND deleted_at IS NULL ORDER BY rowid DESC')
      .all(userId)
      .map(scheduleView);
  }
  /** 生成当前配置或内容的预览。 */
  preview(cron: string) {
    return cronPreview(cron, this.clock(), this.timezone);
  }
  /** 校验并保存当前编辑内容。 */
  save(userId: string, input: ScheduleInput, id?: string, expectedVersion?: number) {
    /** 当前时间。 */
    const now = formatSystemTime(this.clock());
    /** 当前预览数据。 */
    const preview = this.preview(input.cron);
    /** 当前对象名称。 */
    const name = input.name.trim();
    /** 当前记录的正文内容。 */
    const content = input.content.trim();
    if (!name || !content) throw new TaskError('计划名称和内容不能为空');
    if (input.kind === 'reminder') throw new TaskError('固定提醒已停用，请新建 AI 或命令任务');
    /** 已校验的命令执行参数。 */
    let commandSpec: string | null = null;
    if (input.kind === 'command') {
      if (!this.commands) throw new TaskError('命令执行服务不可用');
      if (id) this.get(id, userId);
      commandSpec = JSON.stringify(this.commands.spec(input, input.enabled));
    }
    return transaction(this.db, () => {
      /** 配置变更前的投递目标。 */
      const oldTarget = id
        ? this.db
            .prepare('SELECT delivery_target FROM schedules WHERE id=? AND user_id=?')
            .get(id, userId)?.delivery_target
        : null;
      /** 渠道账号标识。 */
      const channelId =
        input.deliveryChannelId === undefined && oldTarget
          ? (JSON.parse(String(oldTarget)) as DeliveryTarget).accountId
          : input.deliveryChannelId;
      // 停用计划不要求渠道在线；显式保存启用计划则刷新本人绑定快照。
      const target = channelId
        ? !input.enabled &&
          oldTarget &&
          (JSON.parse(String(oldTarget)) as DeliveryTarget).accountId === channelId
          ? String(oldTarget)
          : resolveTarget(this.db, userId, channelId)
        : null;
      if (id) {
        /** 修改前的数据。 */
        const previous = this.get(id, userId);
        if (previous.version !== expectedVersion)
          throw new TaskError('计划已被其他页面更新，请重新加载后编辑', 409);
        this.db
          .prepare(
            'UPDATE schedules SET name=?,kind=?,content=?,cron=?,enabled=?,version=version+1,next_run_at=?,timezone=?,updated_at=? WHERE id=?',
          )
          .run(
            name,
            input.kind,
            content,
            preview.cron,
            Number(input.enabled),
            input.enabled ? preview.nextRuns[0]! : null,
            this.timezone,
            now,
            id,
          );
        this.cancelPending(id, '计划已修改或停用，未启动的执行已取消');
      } else {
        /** 当前统计数量。 */
        const count = Number(
          this.db
            .prepare('SELECT COUNT(*) AS n FROM schedules WHERE user_id=? AND deleted_at IS NULL')
            .get(userId)!.n,
        );
        if (count >= 100) throw new TaskError('最多保存 100 个定时计划', 409);
        id = randomUUID();
        this.db
          .prepare(
            'INSERT INTO schedules (id,user_id,name,kind,content,cron,enabled,version,next_run_at,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?)',
          )
          .run(
            id,
            userId,
            name,
            input.kind,
            content,
            preview.cron,
            Number(input.enabled),
            input.enabled ? preview.nextRuns[0]! : null,
            this.timezone,
            now,
            now,
          );
      }
      this.db.prepare('UPDATE schedules SET delivery_target=? WHERE id=?').run(target, id);
      this.db.prepare('UPDATE schedules SET command_spec=? WHERE id=?').run(commandSpec, id);
      return this.get(id, userId);
    });
  }
  /** 取消尚未开始的待处理记录。 */
  cancelPending(id: string, reason: string) {
    this.db
      .prepare(
        "UPDATE schedule_occurrences SET status='cancelled',reason=?,finished_at=? WHERE schedule_id=? AND status='pending'",
      )
      .run(reason, formatSystemTime(this.clock()), id);
  }
  /** 删除指定记录并更新当前列表。 */
  remove(id: string, userId: string, expectedVersion: number) {
    transaction(this.db, () => {
      /** 修改前的数据。 */
      const previous = this.get(id, userId);
      if (previous.version !== expectedVersion)
        throw new TaskError('计划已被其他页面更新，请重新加载后删除', 409);
      /** 当前时间。 */
      const now = formatSystemTime(this.clock());
      this.db
        .prepare(
          'UPDATE schedules SET deleted_at=?,enabled=0,next_run_at=NULL,version=version+1,updated_at=? WHERE id=?',
        )
        .run(now, now, id);
      this.cancelPending(id, '计划已删除，未启动的执行已取消');
    });
  }
  /** 批量处理选中的记录。 */
  batch(userId: string, input: ScheduleBatchInput) {
    if (new Set(input.items.map((item) => item.id)).size !== input.items.length)
      throw new TaskError('批量操作不能包含重复计划');
    return transaction(this.db, () => {
      /** 当前计划集合或调度器。 */
      const schedules = input.items.map((item) => {
        /** 当前定时计划。 */
        const schedule = this.get(item.id, userId);
        if (schedule.version !== item.expectedVersion)
          throw new TaskError('计划已被其他页面更新，请重新加载后操作', 409);
        return schedule;
      });
      /** 当前时间。 */
      const now = formatSystemTime(this.clock());
      /** 更新后的记录或响应。 */
      let updated = 0;
      for (/* 逐项处理当前定时计划。 */ const schedule of schedules) {
        if (input.operation === 'delete') {
          this.db
            .prepare(
              'UPDATE schedules SET deleted_at=?,enabled=0,next_run_at=NULL,version=version+1,updated_at=? WHERE id=?',
            )
            .run(now, now, schedule.id);
          this.cancelPending(schedule.id, '计划已批量删除，未启动的执行已取消');
          updated++;
          continue;
        }
        /** 当前功能是否启用。 */
        const enabled = input.operation === 'enable';
        if (enabled && schedule.kind === 'reminder') throw new TaskError('固定提醒已停用');
        if (enabled && schedule.kind === 'command') {
          this.commands!.spec(schedule);
        }
        if (schedule.enabled === enabled) continue;
        /** 执行记录中保存的固定投递目标。 */
        const storedTarget = this.db
          .prepare('SELECT delivery_target FROM schedules WHERE id=?')
          .get(schedule.id)?.delivery_target;
        /** 本次处理的目标。 */
        let target = storedTarget == null ? null : String(storedTarget);
        if (enabled && target)
          target = resolveTarget(this.db, userId, (JSON.parse(target) as DeliveryTarget).accountId);
        /** 计划下次触发的本地时间文本。 */
        const nextRunAt = enabled ? this.preview(schedule.cron).nextRuns[0]! : null;
        this.db
          .prepare(
            'UPDATE schedules SET enabled=?,version=version+1,next_run_at=?,timezone=?,updated_at=?,delivery_target=? WHERE id=?',
          )
          .run(Number(enabled), nextRunAt, this.timezone, now, target, schedule.id);
        this.cancelPending(
          schedule.id,
          enabled ? '计划已批量启用，旧的未启动执行已取消' : '计划已批量停用，未启动的执行已取消',
        );
        updated++;
      }
      return { updated };
    });
  }
  /** 判断是否存在活动中的执行。 */
  hasActive(id: string) {
    return !!this.db
      .prepare(
        "SELECT id FROM schedule_occurrences WHERE schedule_id=? AND status IN ('pending','running')",
      )
      .get(id);
  }
  /** 读取指定计划的执行实例。 */
  occurrence(id: string, userId: string) {
    /** schedule_occurrences 表的查询记录。 */
    const row = this.db
      .prepare('SELECT * FROM schedule_occurrences WHERE id=? AND user_id=?')
      .get(id, userId);
    if (!row) throw new TaskError('执行记录不存在', 404);
    return occurrenceView(row);
  }
  // 调用方在事务中登记发生记录和推进计划；返回同键原记录，不重放。
  insert(
    schedule: Schedule,
    userId: string,
    source: 'cron' | 'manual',
    key: string,
    at: string,
    status: ScheduleOccurrence['status'] = 'pending',
    reason: string | null = null,
  ) {
    /** 本次任务固定使用的数据快照。 */
    const snapshot: ScheduleSnapshot = {
      name: schedule.name,
      kind: schedule.kind,
      content: schedule.content,
      cron: schedule.cron,
      enabled: schedule.enabled,
      version: schedule.version,
      timezone: this.timezone,
      deliveryChannelId: schedule.deliveryChannelId ?? null,
      ...(schedule.commandOptions ? { commandOptions: schedule.commandOptions } : {}),
    };
    /** 当前时间。 */
    const now = formatSystemTime(this.clock());
    /** 本次处理的目标。 */
    const target =
      this.db
        .prepare('SELECT delivery_target FROM schedules WHERE id=? AND user_id=?')
        .get(schedule.id, userId)?.delivery_target ?? null;
    this.db
      .prepare(
        'INSERT INTO schedule_occurrences (id,schedule_id,user_id,trigger_key,source,scheduled_at,snapshot,status,reason,created_at,finished_at,delivery_target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(schedule_id,trigger_key) DO NOTHING',
      )
      .run(
        randomUUID(),
        schedule.id,
        userId,
        key,
        source,
        at,
        JSON.stringify(snapshot),
        status,
        reason,
        now,
        status === 'pending' ? null : now,
        target,
      );
    return occurrenceView(
      this.db
        .prepare('SELECT * FROM schedule_occurrences WHERE schedule_id=? AND trigger_key=?')
        .get(schedule.id, key)!,
    );
  }
  /** 完成当前处理并释放等待方。 */
  finish(
    id: string,
    status: ScheduleOccurrence['status'],
    reason: string | null = null,
    finishedAt = formatSystemTime(this.clock()),
  ) {
    this.db
      .prepare(
        "UPDATE schedule_occurrences SET status=?,reason=?,finished_at=? WHERE id=? AND status IN ('pending','running')",
      )
      .run(status, reason, finishedAt, id);
  }
  /** 读取历史记录。 */
  history(
    userId: string,
    before = Number.MAX_SAFE_INTEGER,
    scheduleId?: string,
    unread = false,
  ): ScheduleHistory {
    /** schedule_occurrences 表的查询记录集合。 */
    const rows = this.db
      .prepare(
        `SELECT rowid AS cursor,* FROM schedule_occurrences WHERE user_id=? AND rowid<?
      ${scheduleId ? 'AND schedule_id=?' : ''} ${unread ? "AND status='succeeded' AND read_at IS NULL AND json_extract(snapshot,'$.kind')='reminder'" : ''}
      ORDER BY rowid DESC LIMIT 51`,
      )
      .all(userId, before, ...(scheduleId ? [scheduleId] : []));
    return {
      occurrences: rows.slice(0, 50).map((row) => {
        /** 当前消息投递记录。 */
        const delivery = this.db
          .prepare('SELECT kind,status,error FROM schedule_deliveries WHERE occurrence_id=?')
          .get(row.id!);
        return {
          ...occurrenceView(row),
          delivery: delivery
            ? {
                kind: delivery.kind as DeliveryTarget['kind'],
                status: String(delivery.status),
                error: nullable(delivery.error),
              }
            : null,
        };
      }),
      nextCursor: rows.length > 50 ? Number(rows[49]!.cursor) : null,
    };
  }
  /** 统计当前用户尚未阅读的成功旧提醒记录。 */
  unread(userId: string) {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM schedule_occurrences WHERE user_id=? AND status='succeeded' AND read_at IS NULL AND json_extract(snapshot,'$.kind')='reminder'",
        )
        .get(userId)!.n,
    );
  }
  /** 将成功生成的旧提醒记录标为已读。 */
  markRead(id: string, userId: string) {
    /** 本次计划执行实例。 */
    const occurrence = this.occurrence(id, userId);
    if (occurrence.snapshot.kind !== 'reminder' || occurrence.status !== 'succeeded')
      throw new TaskError('只有已生成的提醒可以标为已读');
    this.db
      .prepare('UPDATE schedule_occurrences SET read_at=COALESCE(read_at,?) WHERE id=?')
      .run(formatSystemTime(this.clock()), id);
  }
}
