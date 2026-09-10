import type { DatabaseSync } from 'node:sqlite';
import type { ChannelKind, ScheduleSnapshot } from '@mlclaw/shared';
import { TaskError } from '../tasks/manager.js';
import { formatSystemTime } from '../time.js';

// 仅服务端保存接收人与绑定代次，HTTP 快照不包含投递凭据。
export interface DeliveryTarget { accountId: string; kind: ChannelKind; senderId: string; bindingVersion: number }
export function resolveTarget(db: DatabaseSync, userId: string, accountId: string): string {
  const row = db.prepare('SELECT * FROM channel_accounts WHERE id=? AND user_id=?').get(accountId, userId);
  if (!row || !row.enabled || !row.paired_sender) throw new TaskError('请选择已启用且已绑定本人的渠道');
  return JSON.stringify({ accountId, kind: row.kind as ChannelKind, senderId: String(row.paired_sender), bindingVersion: Number(row.binding_version) } satisfies DeliveryTarget);
}
export function targetValid(db: DatabaseSync, target: DeliveryTarget, userId: string): boolean {
  return !!db.prepare('SELECT id FROM channel_accounts WHERE id=? AND user_id=? AND kind=? AND paired_sender=? AND binding_version=? AND enabled=1')
    .get(target.accountId, userId, target.kind, target.senderId, target.bindingVersion);
}
export function enqueueScheduleDeliveries(db: DatabaseSync, recovering = false) {
  for (const row of db.prepare(`SELECT o.* FROM schedule_occurrences o LEFT JOIN schedule_deliveries d ON d.occurrence_id=o.id
    WHERE o.delivery_target IS NOT NULL AND d.occurrence_id IS NULL AND o.status NOT IN ('pending','running')`).all()) {
    const target = JSON.parse(String(row.delivery_target)) as DeliveryTarget;
    const snapshot = JSON.parse(String(row.snapshot)) as ScheduleSnapshot;
    let status = 'pending'; let error: string | null = null;
    if (recovering || row.status !== 'succeeded') { status = 'cancelled'; error = recovering ? '服务重启，旧结果不自动投递' : '本次执行未成功，不投递'; }
    else if (!targetValid(db, target, String(row.user_id))) { status = 'cancelled'; error = '渠道已停用、移除或绑定已改变，请重新选择投递渠道'; }
    let content = snapshot.content;
    if (snapshot.kind === 'agent') {
      const parts: string[] = []; let length = 0;
      for (const event of db.prepare("SELECT data FROM task_events WHERE task_id=? AND type='message.delta' ORDER BY seq").iterate(row.task_id!)) {
        const text = String((JSON.parse(String(event.data)) as { text: string }).text);
        parts.push(text.slice(0, 3000)); length += text.length; if (length > 3000) break;
      }
      content = parts.join('') || '任务已完成，无文本回复。';
    }
    const text = content;
    const chars = Array.from(text);
    const bounded = chars.length > 1400 ? chars.slice(0, 1350).join('') + '\n（内容已截断，完整结果请在 MlClaw 网页查看）' : text;
    db.prepare('INSERT INTO schedule_deliveries(occurrence_id,account_id,kind,text,status,error,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(row.id!, target.accountId, target.kind, bounded, status, error, formatSystemTime());
  }
}
