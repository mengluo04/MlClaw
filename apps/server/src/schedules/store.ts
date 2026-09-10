import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { Schedule, ScheduleBatchInput, ScheduleHistory, ScheduleInput, ScheduleOccurrence, ScheduleSnapshot } from '@mlclaw/shared';
import { transaction } from '../db/index.js';
import { TaskError } from '../tasks/manager.js';
import { cronPreview } from './cron.js';
import { resolveTarget, type DeliveryTarget } from './delivery.js';

type Row = Record<string, SQLOutputValue>;
const nullable = (value: SQLOutputValue | undefined) => value == null ? null : String(value);
export function scheduleView(row: Row): Schedule {
  return { id: String(row.id), name: String(row.name), kind: row.kind === 'agent' ? 'agent' : 'reminder',
    content: String(row.content), cron: String(row.cron), enabled: !!row.enabled, version: Number(row.version),
    nextRunAt: nullable(row.next_run_at), createdAt: String(row.created_at),
    deliveryChannelId: row.delivery_target ? (JSON.parse(String(row.delivery_target)) as DeliveryTarget).accountId : null };
}
export function occurrenceView(row: Row): ScheduleOccurrence {
  return { id: String(row.id), scheduleId: String(row.schedule_id), source: row.source === 'manual' ? 'manual' : 'cron',
    scheduledAt: String(row.scheduled_at), snapshot: JSON.parse(String(row.snapshot)) as ScheduleSnapshot,
    status: String(row.status) as ScheduleOccurrence['status'], taskId: nullable(row.task_id), conversationId: nullable(row.conversation_id),
    reason: nullable(row.reason), createdAt: String(row.created_at), startedAt: nullable(row.started_at),
    finishedAt: nullable(row.finished_at), readAt: nullable(row.read_at) };
}

export class ScheduleStore {
  constructor(readonly db: DatabaseSync, readonly timezone: string, readonly clock: () => Date) {}
  get(id: string, userId: string) {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id=? AND user_id=? AND deleted_at IS NULL').get(id, userId);
    if (!row) throw new TaskError('定时计划不存在', 404);
    return scheduleView(row);
  }
  list(userId: string) {
    return this.db.prepare('SELECT * FROM schedules WHERE user_id=? AND deleted_at IS NULL ORDER BY rowid DESC').all(userId).map(scheduleView);
  }
  preview(cron: string) { return cronPreview(cron, this.clock(), this.timezone); }
  save(userId: string, input: ScheduleInput, id?: string, expectedVersion?: number) {
    const now = formatSystemTime(this.clock());
    const preview = this.preview(input.cron);
    const name = input.name.trim(); const content = input.content.trim();
    if (!name || !content) throw new TaskError('计划名称和内容不能为空');
    return transaction(this.db, () => {
      const oldTarget = id ? this.db.prepare('SELECT delivery_target FROM schedules WHERE id=? AND user_id=?').get(id, userId)?.delivery_target : null;
      const channelId = input.deliveryChannelId === undefined && oldTarget ? (JSON.parse(String(oldTarget)) as DeliveryTarget).accountId : input.deliveryChannelId;
      // 停用计划不要求渠道在线；显式保存启用计划则刷新本人绑定快照。
      const target = channelId ? (!input.enabled && oldTarget && (JSON.parse(String(oldTarget)) as DeliveryTarget).accountId === channelId ? String(oldTarget) : resolveTarget(this.db, userId, channelId)) : null;
      if (id) {
        const previous = this.get(id, userId);
        if (previous.version !== expectedVersion) throw new TaskError('计划已被其他页面更新，请重新加载后编辑', 409);
        this.db.prepare('UPDATE schedules SET name=?,kind=?,content=?,cron=?,enabled=?,version=version+1,next_run_at=?,timezone=?,updated_at=? WHERE id=?')
          .run(name, input.kind, content, preview.cron, Number(input.enabled), input.enabled ? preview.nextRuns[0]! : null, this.timezone, now, id);
        this.cancelPending(id, '计划已修改或停用，未启动的执行已取消');
      } else {
        const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE user_id=? AND deleted_at IS NULL').get(userId)!.n);
        if (count >= 100) throw new TaskError('最多保存 100 个定时计划', 409);
        id = randomUUID();
        this.db.prepare('INSERT INTO schedules (id,user_id,name,kind,content,cron,enabled,version,next_run_at,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?)')
          .run(id, userId, name, input.kind, content, preview.cron, Number(input.enabled), input.enabled ? preview.nextRuns[0]! : null, this.timezone, now, now);
      }
      this.db.prepare('UPDATE schedules SET delivery_target=? WHERE id=?').run(target, id);
      return this.get(id, userId);
    });
  }
  cancelPending(id: string, reason: string) {
    this.db.prepare("UPDATE schedule_occurrences SET status='cancelled',reason=?,finished_at=? WHERE schedule_id=? AND status='pending'")
      .run(reason, formatSystemTime(this.clock()), id);
  }
  remove(id: string, userId: string, expectedVersion: number) {
    transaction(this.db, () => {
      const previous = this.get(id, userId);
      if (previous.version !== expectedVersion) throw new TaskError('计划已被其他页面更新，请重新加载后删除', 409);
      const now = formatSystemTime(this.clock());
      this.db.prepare('UPDATE schedules SET deleted_at=?,enabled=0,next_run_at=NULL,version=version+1,updated_at=? WHERE id=?').run(now, now, id);
      this.cancelPending(id, '计划已删除，未启动的执行已取消');
    });
  }
  batch(userId: string, input: ScheduleBatchInput) {
    if (new Set(input.items.map(item => item.id)).size !== input.items.length) throw new TaskError('批量操作不能包含重复计划');
    return transaction(this.db, () => {
      const schedules = input.items.map(item => {
        const schedule = this.get(item.id, userId);
        if (schedule.version !== item.expectedVersion) throw new TaskError('计划已被其他页面更新，请重新加载后操作', 409);
        return schedule;
      });
      const now = formatSystemTime(this.clock());
      let updated = 0;
      for (const schedule of schedules) {
        if (input.operation === 'delete') {
          this.db.prepare('UPDATE schedules SET deleted_at=?,enabled=0,next_run_at=NULL,version=version+1,updated_at=? WHERE id=?').run(now, now, schedule.id);
          this.cancelPending(schedule.id, '计划已批量删除，未启动的执行已取消');
          updated++;
          continue;
        }
        const enabled = input.operation === 'enable';
        if (schedule.enabled === enabled) continue;
        const storedTarget = this.db.prepare('SELECT delivery_target FROM schedules WHERE id=?').get(schedule.id)?.delivery_target;
        let target = storedTarget == null ? null : String(storedTarget);
        if (enabled && target) target = resolveTarget(this.db, userId, (JSON.parse(target) as DeliveryTarget).accountId);
        const nextRunAt = enabled ? this.preview(schedule.cron).nextRuns[0]! : null;
        this.db.prepare('UPDATE schedules SET enabled=?,version=version+1,next_run_at=?,timezone=?,updated_at=?,delivery_target=? WHERE id=?')
          .run(Number(enabled), nextRunAt, this.timezone, now, target, schedule.id);
        this.cancelPending(schedule.id, enabled ? '计划已批量启用，旧的未启动执行已取消' : '计划已批量停用，未启动的执行已取消');
        updated++;
      }
      return { updated };
    });
  }
  hasActive(id: string) { return !!this.db.prepare("SELECT id FROM schedule_occurrences WHERE schedule_id=? AND status IN ('pending','running')").get(id); }
  occurrence(id: string, userId: string) {
    const row = this.db.prepare('SELECT * FROM schedule_occurrences WHERE id=? AND user_id=?').get(id, userId);
    if (!row) throw new TaskError('执行记录不存在', 404);
    return occurrenceView(row);
  }
  // 调用方在事务中登记发生记录和推进计划；返回同键原记录，不重放。
  insert(schedule: Schedule, userId: string, source: 'cron' | 'manual', key: string, at: string,
    status: ScheduleOccurrence['status'] = 'pending', reason: string | null = null) {
    const snapshot: ScheduleSnapshot = { name: schedule.name, kind: schedule.kind, content: schedule.content, cron: schedule.cron,
      enabled: schedule.enabled, version: schedule.version, timezone: this.timezone, deliveryChannelId: schedule.deliveryChannelId ?? null };
    const now = formatSystemTime(this.clock());
    const target = this.db.prepare('SELECT delivery_target FROM schedules WHERE id=? AND user_id=?').get(schedule.id, userId)?.delivery_target ?? null;
    this.db.prepare('INSERT INTO schedule_occurrences (id,schedule_id,user_id,trigger_key,source,scheduled_at,snapshot,status,reason,created_at,finished_at,delivery_target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(schedule_id,trigger_key) DO NOTHING')
      .run(randomUUID(), schedule.id, userId, key, source, at, JSON.stringify(snapshot), status, reason, now, status === 'pending' ? null : now, target);
    return occurrenceView(this.db.prepare('SELECT * FROM schedule_occurrences WHERE schedule_id=? AND trigger_key=?').get(schedule.id, key)!);
  }
  finish(id: string, status: ScheduleOccurrence['status'], reason: string | null = null, finishedAt = formatSystemTime(this.clock())) {
    this.db.prepare("UPDATE schedule_occurrences SET status=?,reason=?,finished_at=? WHERE id=? AND status IN ('pending','running')").run(status, reason, finishedAt, id);
  }
  history(userId: string, before = Number.MAX_SAFE_INTEGER, scheduleId?: string, unread = false): ScheduleHistory {
    const rows = this.db.prepare(`SELECT rowid AS cursor,* FROM schedule_occurrences WHERE user_id=? AND rowid<?
      ${scheduleId ? 'AND schedule_id=?' : ''} ${unread ? "AND status='succeeded' AND read_at IS NULL AND json_extract(snapshot,'$.kind')='reminder'" : ''}
      ORDER BY rowid DESC LIMIT 51`).all(userId, before, ...(scheduleId ? [scheduleId] : []));
    return { occurrences: rows.slice(0, 50).map(row => {
      const delivery = this.db.prepare('SELECT kind,status,error FROM schedule_deliveries WHERE occurrence_id=?').get(row.id!);
      return { ...occurrenceView(row), delivery: delivery ? { kind: delivery.kind as DeliveryTarget['kind'], status: String(delivery.status), error: nullable(delivery.error) } : null };
    }), nextCursor: rows.length > 50 ? Number(rows[49]!.cursor) : null };
  }
  unread(userId: string) {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM schedule_occurrences WHERE user_id=? AND status='succeeded' AND read_at IS NULL AND json_extract(snapshot,'$.kind')='reminder'").get(userId)!.n);
  }
  markRead(id: string, userId: string) {
    const occurrence = this.occurrence(id, userId);
    if (occurrence.snapshot.kind !== 'reminder' || occurrence.status !== 'succeeded') throw new TaskError('只有已生成的提醒可以标为已读');
    this.db.prepare('UPDATE schedule_occurrences SET read_at=COALESCE(read_at,?) WHERE id=?').run(formatSystemTime(this.clock()), id);
  }
}
