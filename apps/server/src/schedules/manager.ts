import { formatSystemTime, parseSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/index.js';
import { TaskError, type TaskManager } from '../tasks/manager.js';
import { cronPreview, serverTimezone } from './cron.js';
import { occurrenceView, scheduleView, ScheduleStore } from './store.js';
import { enqueueScheduleDeliveries } from './delivery.js';
import type { SystemLogService } from '../system-logs/service.js';
import type { ScheduleCommands } from './commands.js';

export interface SchedulerOptions {
  clock?: () => Date;
  onError?: (error: unknown) => void;
}
export class ScheduleManager {
  /** 当前业务的数据存取实例。 */
  readonly store: ScheduleStore;
  /** 当前错误提示。 */
  error: string | null = null;
  /** 延迟执行或超时控制的定时器句柄。 */
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private db: DatabaseSync,
    private tasks: TaskManager,
    private options: SchedulerOptions = {},
    private logs?: SystemLogService,
    readonly commands?: ScheduleCommands,
  ) {
    this.store = new ScheduleStore(
      db,
      serverTimezone(),
      options.clock ?? (() => new Date()),
      commands,
    );
    this.recover();
  }
  /** 对照最新配置协调当前运行状态。 */
  private reconcile() {
    for (/* 逐项处理当前数据库记录。 */ const row of this.db
      .prepare(
        "SELECT o.id,t.status,t.error,t.finished_at FROM schedule_occurrences o LEFT JOIN tasks t ON t.id=o.task_id WHERE o.status='running' AND json_extract(o.snapshot,'$.kind')<>'command'",
      )
      .all()) {
      if (row.status && ['queued', 'running', 'waiting_approval'].includes(String(row.status)))
        continue;
      this.store.finish(
        String(row.id),
        row.status
          ? (String(row.status) as 'succeeded' | 'failed' | 'cancelled' | 'interrupted')
          : 'interrupted',
        row.status
          ? row.error == null
            ? null
            : String(row.error)
          : '关联任务已删除或丢失，未自动重放',
        row.finished_at == null ? undefined : String(row.finished_at),
      );
    }
  }
  /** 恢复中断记录的状态，避免重放副作用。 */
  private recover() {
    transaction(this.db, () => {
      this.reconcile();
      this.db
        .prepare(
          "UPDATE schedule_occurrences SET status='cancelled',reason='服务重启，未启动的执行不自动恢复',finished_at=? WHERE status='pending'",
        )
        .run(formatSystemTime(this.store.clock()));
      enqueueScheduleDeliveries(this.db, true);
      /** 当前时间。 */
      const now = this.store.clock();
      for (/* 逐项处理当前数据库记录。 */ const row of this.db
        .prepare('SELECT * FROM schedules WHERE enabled=1 AND deleted_at IS NULL')
        .all()) {
        /** 当前定时计划。 */
        const schedule = scheduleView(row);
        if (schedule.nextRunAt && schedule.nextRunAt <= formatSystemTime(now)) {
          this.store.insert(
            schedule,
            String(row.user_id),
            'cron',
            `cron:${parseSystemTime(schedule.nextRunAt)}`,
            schedule.nextRunAt,
            'skipped',
            `服务停机或重启，已跳过 ${schedule.nextRunAt} 至 ${formatSystemTime(now)} 期间错过的触发，不补跑`,
          );
        }
        if (
          row.timezone !== this.store.timezone ||
          !schedule.nextRunAt ||
          schedule.nextRunAt <= formatSystemTime(now)
        )
          this.advance(schedule.id, schedule.cron, now);
      }
    });
  }
  /** 按 Cron 重新计算并保存计划的下次触发时间。 */
  private advance(id: string, cron: string, now: Date) {
    /** 下一次处理使用的数据。 */
    const next = cronPreview(cron, now, this.store.timezone, 1).nextRuns[0]!;
    this.db
      .prepare('UPDATE schedules SET next_run_at=?,timezone=? WHERE id=?')
      .run(next, this.store.timezone, id);
  }
  /** 启动当前服务或状态订阅。 */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), 2000);
    this.timer.unref();
    this.pump();
  }
  /** 执行一次调度扫描并记录失败或恢复状态。 */
  private pump() {
    try {
      this.tick();
      if (this.error)
        this.logs?.recordAll({
          level: 'info',
          source: 'schedule',
          event: 'schedule.scheduler_recovered',
          message: '定时调度已恢复正常',
        });
      this.error = null;
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      if (!this.error) {
        this.logs?.recordAll({
          level: 'error',
          source: 'schedule',
          event: 'schedule.scheduler_failed',
          message: '定时调度检查失败，请检查服务日志',
        });
        this.options.onError?.(error);
      }
      this.error = '定时调度检查失败，请检查服务日志；记录保留后重试';
    }
  }
  /** 关闭当前资源或编辑界面。 */
  close() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  // 全部登记/派发操作同步执行，不跨 await；避免扫描器自身重叠。
  tick() {
    /** 当前时间。 */
    const now = this.store.clock();
    this.reconcile();
    /** 本轮因延迟或重叠而跳过的计划记录。 */
    const skipped: Array<{ userId: string; id: string; reason: string }> = [];
    transaction(this.db, () => {
      for (/* 逐项处理当前数据库记录。 */ const row of this.db
        .prepare(
          'SELECT * FROM schedules WHERE enabled=1 AND deleted_at IS NULL AND next_run_at<=? ORDER BY next_run_at,id',
        )
        .all(formatSystemTime(now))) {
        /** 当前定时计划。 */
        const schedule = scheduleView(row);
        /** 当前处理的时间或位置。 */
        const at = schedule.nextRunAt!;
        /** 本次处理是否已超过允许的延迟。 */
        const late = now.getTime() - parseSystemTime(at) >= 60000;
        /** 该计划是否已有尚未结束的执行实例。 */
        const overlap = this.store.hasActive(schedule.id);
        this.store.insert(
          schedule,
          String(row.user_id),
          'cron',
          `cron:${parseSystemTime(at)}`,
          at,
          late || overlap ? 'skipped' : 'pending',
          late
            ? `服务未及时调度，已跳过 ${at} 至 ${formatSystemTime(now)} 期间错过的触发`
            : overlap
              ? '同一计划的上一执行尚未结束'
              : null,
        );
        if (late || overlap)
          skipped.push({
            userId: String(row.user_id),
            id: schedule.id,
            reason: late ? 'late' : 'overlap',
          });
        this.advance(schedule.id, schedule.cron, now);
      }
    });
    for (/* 逐项处理当前处理的条目。 */ const item of skipped)
      this.logs?.record(item.userId, {
        level: 'warning',
        source: 'schedule',
        event: 'schedule.occurrence_skipped',
        message:
          item.reason === 'late'
            ? '定时任务因调度延迟被跳过'
            : '定时任务因上一次执行尚未结束被跳过',
        entity: { type: 'schedule', id: item.id },
        metadata: { reason: item.reason },
      });
    for (/* 逐项处理当前数据库记录。 */ const row of this.db
      .prepare(
        "SELECT * FROM schedule_occurrences WHERE status='pending' ORDER BY scheduled_at,rowid",
      )
      .all()) {
      /** 本次计划执行实例。 */
      const occurrence = occurrenceView(row);
      if (now.getTime() - parseSystemTime(occurrence.scheduledAt) >= 600000) {
        this.store.finish(occurrence.id, 'skipped', '等待执行超过 10 分钟，已跳过');
        this.logs?.record(String(row.user_id), {
          level: 'warning',
          source: 'schedule',
          event: 'schedule.occurrence_skipped',
          message: '定时任务等待执行超时，已跳过',
          entity: { type: 'occurrence', id: occurrence.id },
          metadata: { reason: 'queue_timeout' },
        });
        continue;
      }
      if (occurrence.snapshot.kind === 'reminder') {
        this.store.finish(occurrence.id, 'cancelled', '固定提醒已停用');
        continue;
      }
      if (this.tasks.isBusy()) continue;
      try {
        if (occurrence.snapshot.kind === 'command') {
          if (!this.commands) throw new TaskError('命令执行服务不可用');
          this.commands.start(occurrence.id, occurrence.snapshot);
          continue;
        }
        /** 完成参数校验与快照固定后的执行数据。 */
        const prepared = transaction(this.db, () => {
          /** 当前会话标识。 */
          const conversationId = randomUUID();
          /** 当前操作所属用户的标识。 */
          const userId = String(row.user_id);
          this.db
            .prepare('INSERT INTO conversations VALUES (?,?,?,?)')
            .run(
              conversationId,
              userId,
              `定时：${occurrence.snapshot.name}`.slice(0, 100),
              formatSystemTime(now),
            );
          /** 当前任务记录。 */
          const task = this.tasks.prepare(
            userId,
            conversationId,
            occurrence.snapshot.content,
            `schedule:${occurrence.id}`,
            'readonly',
          );
          this.db
            .prepare(
              "UPDATE schedule_occurrences SET status='running',task_id=?,conversation_id=?,started_at=? WHERE id=? AND status='pending'",
            )
            .run(task.taskId, conversationId, formatSystemTime(now), occurrence.id);
          return task;
        });
        prepared.start();
      } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
        if (
          occurrence.snapshot.kind !== 'command' &&
          error instanceof TaskError &&
          error.statusCode === 409
        )
          continue;
        // 已提交的任务不得回到 pending；未知失败不自动重跑。
        this.store.finish(
          occurrence.id,
          'failed',
          error instanceof TaskError ? error.message : '定时任务启动失败，请检查服务日志',
        );
        this.logs?.record(String(row.user_id), {
          level: 'error',
          source: 'schedule',
          event: 'schedule.occurrence_failed',
          message: '定时任务启动失败',
          entity: { type: 'occurrence', id: occurrence.id },
        });
        if (!(error instanceof TaskError)) this.options.onError?.(error);
      }
    }
  }
  /** 立即创建并执行指定计划的实例。 */
  runNow(id: string, userId: string, key: string, expectedVersion: number) {
    this.reconcile();
    /** schedule_occurrences 表的查询记录。 */
    const result = transaction(this.db, () => {
      /** schedule_occurrences 表的查询记录。 */
      const previous = this.db
        .prepare(
          'SELECT * FROM schedule_occurrences WHERE schedule_id=? AND user_id=? AND trigger_key=?',
        )
        .get(id, userId, `manual:${key}`);
      if (previous) {
        /** 本次计划执行实例。 */
        const occurrence = occurrenceView(previous);
        if (occurrence.snapshot.version !== expectedVersion)
          throw new TaskError('幂等键已绑定其他版本的计划', 409);
        return occurrence;
      }
      /** 当前定时计划。 */
      const schedule = this.store.get(id, userId);
      if (schedule.kind === 'reminder') throw new TaskError('固定提醒已停用');
      if (schedule.version !== expectedVersion)
        throw new TaskError('计划已被其他页面更新，请重新加载后运行', 409);
      if (this.store.hasActive(id)) throw new TaskError('该计划已有执行等待或运行中', 409);
      return this.store.insert(
        schedule,
        userId,
        'manual',
        `manual:${key}`,
        formatSystemTime(this.store.clock()),
      );
    });
    // 只登记；统一扫描器派发，HTTP 重试不会再次启动执行。
    return result;
  }
  /** 取消当前执行并更新相关状态。 */
  cancel(id: string, userId: string) {
    this.reconcile();
    /** 本次计划执行实例。 */
    const occurrence = this.store.occurrence(id, userId);
    if (occurrence.status === 'running' && occurrence.snapshot.kind === 'command') {
      this.commands?.cancel(id);
      return;
    }
    if (occurrence.status === 'running' && occurrence.taskId)
      this.tasks.cancel(occurrence.taskId, userId);
    this.store.finish(id, 'cancelled', '用户取消本次执行');
  }
}
