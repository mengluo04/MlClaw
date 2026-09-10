import { formatSystemTime, parseSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/index.js';
import { TaskError, type TaskManager } from '../tasks/manager.js';
import { cronPreview, serverTimezone } from './cron.js';
import { occurrenceView, scheduleView, ScheduleStore } from './store.js';
import { enqueueScheduleDeliveries } from './delivery.js';
import type { SystemLogService } from '../system-logs/service.js';

export interface SchedulerOptions { clock?: () => Date; onError?: (error: unknown) => void }
export class ScheduleManager {
  readonly store: ScheduleStore;
  error: string | null = null;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private db: DatabaseSync, private tasks: TaskManager, private options: SchedulerOptions = {}, private logs?: SystemLogService) {
    this.store = new ScheduleStore(db, serverTimezone(), options.clock ?? (() => new Date()));
    this.recover();
  }
  private reconcile() {
    for (const row of this.db.prepare("SELECT o.id,t.status,t.error,t.finished_at FROM schedule_occurrences o LEFT JOIN tasks t ON t.id=o.task_id WHERE o.status='running'").all()) {
      if (row.status && ['queued', 'running', 'waiting_approval'].includes(String(row.status))) continue;
      this.store.finish(String(row.id), row.status ? String(row.status) as 'succeeded' | 'failed' | 'cancelled' | 'interrupted' : 'interrupted',
        row.status ? row.error == null ? null : String(row.error) : '关联任务已删除或丢失，未自动重放',
        row.finished_at == null ? undefined : String(row.finished_at));
    }
  }
  private recover() {
    transaction(this.db, () => {
      this.reconcile();
      this.db.prepare("UPDATE schedule_occurrences SET status='cancelled',reason='服务重启，未启动的执行不自动恢复',finished_at=? WHERE status='pending'").run(formatSystemTime(this.store.clock()));
      enqueueScheduleDeliveries(this.db, true);
      const now = this.store.clock();
      for (const row of this.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND deleted_at IS NULL').all()) {
        const schedule = scheduleView(row);
        if (schedule.nextRunAt && schedule.nextRunAt <= formatSystemTime(now)) {
          this.store.insert(schedule, String(row.user_id), 'cron', `cron:${parseSystemTime(schedule.nextRunAt)}`, schedule.nextRunAt, 'skipped',
            `服务停机或重启，已跳过 ${schedule.nextRunAt} 至 ${formatSystemTime(now)} 期间错过的触发，不补跑`);
        }
        if (row.timezone !== this.store.timezone || !schedule.nextRunAt || schedule.nextRunAt <= formatSystemTime(now)) this.advance(schedule.id, schedule.cron, now);
      }
    });
  }
  private advance(id: string, cron: string, now: Date) {
    const next = cronPreview(cron, now, this.store.timezone, 1).nextRuns[0]!;
    this.db.prepare('UPDATE schedules SET next_run_at=?,timezone=? WHERE id=?').run(next, this.store.timezone, id);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), 2000);
    this.timer.unref();
    this.pump();
  }
  private pump() {
    try {
      this.tick();
      if (this.error) this.logs?.recordAll({ level: 'info', source: 'schedule', event: 'schedule.scheduler_recovered', message: '定时调度已恢复正常' });
      this.error = null;
    }
    catch (error) {
      if (!this.error) {
        this.logs?.recordAll({ level: 'error', source: 'schedule', event: 'schedule.scheduler_failed', message: '定时调度检查失败，请检查服务日志' });
        this.options.onError?.(error);
      }
      this.error = '定时调度检查失败，请检查服务日志；记录保留后重试';
    }
  }
  close() { clearInterval(this.timer); this.timer = undefined; }
  // 全部登记/派发操作同步执行，不跨 await；避免扫描器自身重叠。
  tick() {
    const now = this.store.clock();
    this.reconcile();
    const skipped: Array<{ userId: string; id: string; reason: string }> = [];
    transaction(this.db, () => {
      for (const row of this.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND deleted_at IS NULL AND next_run_at<=? ORDER BY next_run_at,id').all(formatSystemTime(now))) {
        const schedule = scheduleView(row); const at = schedule.nextRunAt!;
        const late = now.getTime() - parseSystemTime(at) >= 60000;
        const overlap = this.store.hasActive(schedule.id);
        this.store.insert(schedule, String(row.user_id), 'cron', `cron:${parseSystemTime(at)}`, at, late || overlap ? 'skipped' : 'pending',
          late ? `服务未及时调度，已跳过 ${at} 至 ${formatSystemTime(now)} 期间错过的触发` : overlap ? '同一计划的上一执行尚未结束' : null);
        if (late || overlap) skipped.push({ userId: String(row.user_id), id: schedule.id, reason: late ? 'late' : 'overlap' });
        this.advance(schedule.id, schedule.cron, now);
      }
    });
    for (const item of skipped) this.logs?.record(item.userId, { level: 'warning', source: 'schedule', event: 'schedule.occurrence_skipped', message: item.reason === 'late' ? '定时任务因调度延迟被跳过' : '定时任务因上一次执行尚未结束被跳过', entity: { type: 'schedule', id: item.id }, metadata: { reason: item.reason } });
    for (const row of this.db.prepare("SELECT * FROM schedule_occurrences WHERE status='pending' ORDER BY scheduled_at,rowid").all()) {
      const occurrence = occurrenceView(row);
      if (now.getTime() - parseSystemTime(occurrence.scheduledAt) >= 600000) {
        this.store.finish(occurrence.id, 'skipped', '等待执行超过 10 分钟，已跳过');
        this.logs?.record(String(row.user_id), { level: 'warning', source: 'schedule', event: 'schedule.occurrence_skipped', message: '定时任务等待执行超时，已跳过', entity: { type: 'occurrence', id: occurrence.id }, metadata: { reason: 'queue_timeout' } }); continue;
      }
      if (occurrence.snapshot.kind === 'reminder') {
        this.db.prepare("UPDATE schedule_occurrences SET status='succeeded',started_at=?,finished_at=? WHERE id=? AND status='pending'")
          .run(formatSystemTime(now), formatSystemTime(now), occurrence.id);
        this.logs?.record(String(row.user_id), { level: 'info', source: 'schedule', event: 'schedule.reminder_completed', message: '定时提醒已生成', entity: { type: 'occurrence', id: occurrence.id }, metadata: { scheduledAt: occurrence.scheduledAt } });
        continue;
      }
      if (this.tasks.isBusy()) continue;
      try {
        const prepared = transaction(this.db, () => {
          const conversationId = randomUUID(); const userId = String(row.user_id);
          this.db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run(conversationId, userId, `定时：${occurrence.snapshot.name}`.slice(0, 100), formatSystemTime(now));
          const task = this.tasks.prepare(userId, conversationId, occurrence.snapshot.content, `schedule:${occurrence.id}`, 'readonly');
          this.db.prepare("UPDATE schedule_occurrences SET status='running',task_id=?,conversation_id=?,started_at=? WHERE id=? AND status='pending'")
            .run(task.taskId, conversationId, formatSystemTime(now), occurrence.id);
          return task;
        });
        prepared.start();
      } catch (error) {
        if (error instanceof TaskError && error.statusCode === 409) continue;
        // 已提交的任务不得回到 pending；未知失败不自动重跑。
        this.store.finish(occurrence.id, 'failed', error instanceof TaskError ? error.message : '定时任务启动失败，请检查服务日志');
        this.logs?.record(String(row.user_id), { level: 'error', source: 'schedule', event: 'schedule.occurrence_failed', message: '定时任务启动失败', entity: { type: 'occurrence', id: occurrence.id } });
        if (!(error instanceof TaskError)) this.options.onError?.(error);
      }
    }
  }
  runNow(id: string, userId: string, key: string, expectedVersion: number) {
    this.reconcile();
    const result = transaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM schedule_occurrences WHERE schedule_id=? AND user_id=? AND trigger_key=?').get(id, userId, `manual:${key}`);
      if (previous) {
        const occurrence = occurrenceView(previous);
        if (occurrence.snapshot.version !== expectedVersion) throw new TaskError('幂等键已绑定其他版本的计划', 409);
        return occurrence;
      }
      const schedule = this.store.get(id, userId);
      if (schedule.version !== expectedVersion) throw new TaskError('计划已被其他页面更新，请重新加载后运行', 409);
      if (this.store.hasActive(id)) throw new TaskError('该计划已有执行等待或运行中', 409);
      return this.store.insert(schedule, userId, 'manual', `manual:${key}`, formatSystemTime(this.store.clock()));
    });
    // 只登记；统一扫描器派发，HTTP 重试不会再次启动执行。
    return result;
  }
  cancel(id: string, userId: string) {
    this.reconcile();
    const occurrence = this.store.occurrence(id, userId);
    if (occurrence.status === 'running' && occurrence.taskId) this.tasks.cancel(occurrence.taskId, userId);
    this.store.finish(id, 'cancelled', '用户取消本次执行');
  }
}
