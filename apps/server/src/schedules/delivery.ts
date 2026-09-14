import type { DatabaseSync } from 'node:sqlite';
import type { ChannelKind, ScheduleSnapshot } from '@mlclaw/shared';
import { TaskError } from '../tasks/manager.js';
import { formatSystemTime } from '../time.js';
import { savedTaskText } from '../tasks/output.js';

// 仅服务端保存接收人与绑定代次，HTTP 快照不包含投递凭据。
export interface DeliveryTarget {
  accountId: string;
  kind: ChannelKind;
  senderId: string;
  bindingVersion: number;
}
/** 检查渠道归属及绑定状态后生成投递目标。 */
export const resolveTarget = (db: DatabaseSync, userId: string, accountId: string): string => {
  /** channel_accounts 表的查询记录。 */
  const row = db
    .prepare('SELECT * FROM channel_accounts WHERE id=? AND user_id=?')
    .get(accountId, userId);
  if (!row || !row.enabled || !row.paired_sender)
    throw new TaskError('请选择已启用且已绑定本人或已配置接收地址的渠道');
  return JSON.stringify({
    accountId,
    kind: row.kind as ChannelKind,
    senderId: String(row.paired_sender),
    bindingVersion: Number(row.binding_version),
  } satisfies DeliveryTarget);
};
/** 检查投递目标的账号、归属与绑定代次是否仍有效。 */
export const targetValid = (db: DatabaseSync, target: DeliveryTarget, userId: string): boolean => {
  return !!db
    .prepare(
      'SELECT id FROM channel_accounts WHERE id=? AND user_id=? AND kind=? AND paired_sender=? AND binding_version=? AND enabled=1',
    )
    .get(target.accountId, userId, target.kind, target.senderId, target.bindingVersion);
};
/** 为已完成计划生成投递记录，并处理重启恢复状态。 */
export const enqueueScheduleDeliveries = (db: DatabaseSync, recovering = false) => {
  for (/* 逐项处理当前数据库记录。 */ const row of db
    .prepare(
      `SELECT o.* FROM schedule_occurrences o LEFT JOIN schedule_deliveries d ON d.occurrence_id=o.id
    WHERE o.delivery_target IS NOT NULL AND d.occurrence_id IS NULL AND o.status NOT IN ('pending','running')`,
    )
    .all()) {
    /** 本次处理的目标。 */
    const target = JSON.parse(String(row.delivery_target)) as DeliveryTarget;
    /** 本次任务固定使用的数据快照。 */
    const snapshot = JSON.parse(String(row.snapshot)) as ScheduleSnapshot;
    /** 当前业务状态。 */
    let status = 'pending';
    /** 当前错误提示。 */
    let error: string | null = null;
    if (recovering || row.status !== 'succeeded') {
      status = 'cancelled';
      error = recovering ? '服务重启，旧结果不自动投递' : '本次执行未成功，不投递';
    } else if (!targetValid(db, target, String(row.user_id))) {
      status = 'cancelled';
      error = '渠道已停用、移除或绑定已改变，请重新选择投递渠道';
    }
    /** 当前记录的正文内容。 */
    let content = snapshot.content;
    if (snapshot.kind === 'command') {
      /** 从 JSON 文本解析的结构化数据，后续仍需按业务规则校验。 */
      const result = row.command_result
        ? (JSON.parse(String(row.command_result)) as {
            stdout: string;
            stderr: string;
            exitCode: number | null;
          })
        : null;
      content = result
        ? `命令完成（退出码 ${result.exitCode ?? '未知'}）\n${result.stdout}\n${result.stderr}`
        : '命令已完成，无输出。';
    }
    if (snapshot.kind === 'agent') {
      content =
        savedTaskText(db, String(row.task_id), target.kind === 'email' ? 200002 : 3000) ||
        '任务已完成，无文本回复。';
    }
    /** 当前处理的文本。 */
    const text = content;
    /** 本次处理的字符数量。 */
    const chars = Array.from(text);
    /** 已按上限截取的内容。 */
    const bounded =
      chars.length > (target.kind === 'email' ? 100000 : 1400)
        ? chars.slice(0, target.kind === 'email' ? 99950 : 1350).join('') +
          '\n（内容已截断，完整结果请在 MlClaw 网页查看）'
        : text;
    db.prepare(
      'INSERT INTO schedule_deliveries(occurrence_id,account_id,kind,text,status,error,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(row.id!, target.accountId, target.kind, bounded, status, error, formatSystemTime());
  }
};
