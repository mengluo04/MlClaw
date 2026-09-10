import { formatSystemTime, parseSystemTime } from '../time.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { ChannelAccountView, ChannelKind, ChannelSettings } from '@mlclaw/shared';
import { TaskError, type TaskManager } from '../tasks/manager.js';
import { transaction } from '../db/index.js';
import { boundedString, ChannelError, DeliveryError, type ChannelAccount, type ChannelTransport, type InboundMessage, type TransportFactory } from './types.js';
import { QQTransport } from './qq.js';
import { WeixinTransport } from './weixin.js';
import { enqueueScheduleDeliveries, targetValid, type DeliveryTarget } from '../schedules/delivery.js';
import type { SystemLogService } from '../system-logs/service.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => formatSystemTime();
type Row = Record<string, SQLOutputValue>;
interface Runtime { controller: AbortController; transport: ChannelTransport; run: Promise<void>; sending?: Promise<void> }
const defaultFactory: TransportFactory = (account, sink) => account.kind === 'qq' ? new QQTransport(account, sink) : new WeixinTransport(account, sink);

export class ChannelManager {
  private runtimes = new Map<string, Runtime>();
  private states = new Map<string, Pick<ChannelAccountView, 'state' | 'message'>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private mutations = new Set<string>();
  private bindingAttempts = new Map<string, { count: number; until: number }>();
  constructor(readonly db: DatabaseSync, private tasks: TaskManager, private factory: TransportFactory = defaultFactory, private logs?: SystemLogService) {
    // 已启动任务由 TaskManager 标为 interrupted；渠道绝不重放旧入站或不明投递。
    db.exec("UPDATE channel_inbox SET status='interrupted' WHERE status IN ('received','running'); UPDATE channel_outbox SET status='unknown',error='服务重启，投递结果未确认，请到原聊天核对' WHERE status='sending'; UPDATE channel_outbox SET status='cancelled',error='服务重启，未自动投递旧回复' WHERE status='pending';");
    enqueueScheduleDeliveries(db, true);
    db.exec("UPDATE schedule_deliveries SET status='unknown',error='服务重启，投递结果未确认，不自动重发' WHERE status='sending'; UPDATE schedule_deliveries SET status='cancelled',error='服务重启，不自动投递旧结果' WHERE status='pending';");
  }
  start() {
    if (this.timer || this.stopped) return;
    for (const row of this.db.prepare('SELECT id FROM channel_accounts WHERE enabled=1').all()) this.connect(String(row.id));
    this.timer = setInterval(() => {
      try { this.tick(); } catch { for (const id of this.runtimes.keys()) this.updateState(id, 'error', '渠道事件处理失败，请检查数据库状态'); }
    }, 250); this.timer.unref();
  }
  account(id: string, userId?: string): ChannelAccount {
    const row = userId ? this.db.prepare('SELECT * FROM channel_accounts WHERE id=? AND user_id=?').get(id, userId) : this.db.prepare('SELECT * FROM channel_accounts WHERE id=?').get(id);
    if (!row) throw new ChannelError('渠道不存在', 404);
    return { id: String(row.id), userId: String(row.user_id), kind: row.kind as ChannelKind, remoteId: String(row.remote_id), secret: String(row.secret), baseUrl: String(row.base_url), enabled: !!row.enabled, cursor: String(row.cursor), pairedSender: row.paired_sender === null ? null : String(row.paired_sender) };
  }
  view(userId: string): ChannelSettings {
    const accounts = this.db.prepare('SELECT id FROM channel_accounts WHERE user_id=? ORDER BY kind').all(userId).map(row => {
      const a = this.account(String(row.id), userId);
      return { id: a.id, kind: a.kind, remoteId: a.remoteId, enabled: a.enabled, hasCredential: !!a.secret, pairedSender: a.pairedSender,
        ...(this.states.get(a.id) ?? { state: 'stopped' as const, message: '' }) };
    });
    const deliveries = this.db.prepare(`SELECT o.id,o.status,o.error,o.created_at,a.kind,i.task_id,t.conversation_id
      FROM channel_outbox o JOIN channel_inbox i ON i.id=o.inbox_id JOIN channel_accounts a ON a.id=i.account_id
      LEFT JOIN tasks t ON t.id=i.task_id WHERE a.user_id=? ORDER BY o.rowid DESC LIMIT 30`).all(userId).map(row => ({
        id: String(row.id), kind: row.kind as ChannelKind, status: String(row.status), error: row.error === null ? null : String(row.error), createdAt: String(row.created_at),
        taskId: row.task_id === null ? null : String(row.task_id), conversationId: row.conversation_id === null ? null : String(row.conversation_id),
      }));
    return { accounts, deliveries };
  }
  async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new ChannelError('服务正在关闭', 503);
    if (this.mutations.has(key)) throw new ChannelError('渠道正在更新，请稍后重试', 409);
    this.mutations.add(key); try { return await operation(); } finally { this.mutations.delete(key); }
  }
  async configure(userId: string, kind: ChannelKind, remoteId: string, secret: string | undefined, baseUrl = '') {
    return this.exclusive(`${userId}:${kind}`, async () => {
      const previous = this.db.prepare('SELECT id FROM channel_accounts WHERE user_id=? AND kind=?').get(userId, kind);
      const old = previous ? this.account(String(previous.id), userId) : undefined;
      const credential = secret ?? (old?.remoteId === remoteId ? old.secret : '');
      if (!credential || credential.length > 4096 || /[\s\u0000-\u001f]/.test(credential)) throw new ChannelError('请填写有效的渠道凭据');
      if (old) await this.disconnect(old.id);
      const id = old?.remoteId === remoteId ? old.id : randomUUID();
      transaction(this.db, () => {
        if (old && old.id !== id) this.db.prepare('DELETE FROM channel_accounts WHERE id=?').run(old.id);
        this.db.prepare(`INSERT INTO channel_accounts(id,user_id,kind,remote_id,secret,base_url,created_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,base_url=excluded.base_url,enabled=0,cursor='',pairing_hash=NULL,pairing_expires_at=NULL`).run(id, userId, kind, remoteId, credential, baseUrl, now());
      });
      this.updateState(id, 'stopped');
      this.logs?.record(userId, { level: 'info', source: 'channel', event: 'channel.configured', message: `${kind === 'qq' ? 'QQ' : '微信'}渠道配置已保存`, entity: { type: 'channel', id }, metadata: { channelKind: kind } }); return { id };
    });
  }
  async enable(id: string, userId: string, enabled: boolean) {
    const account = this.account(id, userId);
    await this.exclusive(`${userId}:${account.kind}`, async () => {
      await this.disconnect(id); this.db.prepare('UPDATE channel_accounts SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
      if (enabled) this.connect(id);
      this.logs?.record(userId, { level: 'info', source: 'channel', event: enabled ? 'channel.enabled' : 'channel.disabled', message: `${account.kind === 'qq' ? 'QQ' : '微信'}渠道已${enabled ? '启用' : '停用'}`, entity: { type: 'channel', id }, metadata: { channelKind: account.kind } });
    });
  }
  async remove(id: string, userId: string) {
    const account = this.account(id, userId);
    await this.exclusive(`${userId}:${account.kind}`, async () => {
      await this.disconnect(id); this.logs?.record(userId, { level: 'info', source: 'channel', event: 'channel.removed', message: `${account.kind === 'qq' ? 'QQ' : '微信'}渠道已移除`, entity: { type: 'channel', id }, metadata: { channelKind: account.kind } }); this.db.prepare('DELETE FROM channel_accounts WHERE id=?').run(id); this.states.delete(id); this.bindingAttempts.delete(id);
    });
  }
  pairCode(id: string, userId: string) {
    const account = this.account(id, userId);
    if (account.pairedSender) throw new ChannelError('请先解除已有身份绑定', 409);
    const code = randomBytes(5).toString('hex').toUpperCase(); const expiresAt = formatSystemTime(new Date(Date.now() + 300000));
    this.db.prepare('UPDATE channel_accounts SET pairing_hash=?,pairing_expires_at=? WHERE id=?').run(hash(code), expiresAt, id);
    return { code, expiresAt, expiresInSeconds: 300 };
  }
  async unpair(id: string, userId: string) {
    const account = this.account(id, userId);
    await this.exclusive(`${userId}:${account.kind}`, async () => {
      await this.disconnect(id);
      this.db.prepare('UPDATE channel_accounts SET enabled=0,paired_sender=NULL,pairing_hash=NULL,pairing_expires_at=NULL,binding_version=binding_version+1 WHERE id=?').run(id);
      // 新绑定不能继承之前身份的会话映射；原历史仍可在网页查看。
      this.db.prepare('DELETE FROM channel_conversations WHERE account_id=?').run(id);
    });
  }
  private connect(id: string) {
    if (this.stopped || this.runtimes.has(id)) return;
    const account = this.account(id); const controller = new AbortController();
    this.updateState(id, 'connecting');
    const transport = this.factory(account, {
      receive: message => { if (!controller.signal.aborted) this.receive(id, message); },
      cursor: value => { if (!controller.signal.aborted) this.db.prepare('UPDATE channel_accounts SET cursor=? WHERE id=?').run(value, id); },
      state: (state, message = '') => { if (!controller.signal.aborted) this.updateState(id, state, message); },
    });
    const runtime: Runtime = { controller, transport, run: Promise.resolve() };
    this.runtimes.set(id, runtime);
    runtime.run = Promise.resolve().then(() => transport.run(controller.signal)).catch(() => {
      if (!controller.signal.aborted) this.updateState(id, 'error', '渠道连接失败，请检查凭据和平台权限后重新连接');
    });
  }
  private async disconnect(id: string) {
    const runtime = this.runtimes.get(id); runtime?.controller.abort();
    for (const row of this.db.prepare("SELECT i.task_id,a.user_id FROM channel_inbox i JOIN channel_accounts a ON a.id=i.account_id WHERE i.account_id=? AND i.status='running'").all(id)) {
      if (row.task_id && this.tasks.isActive(String(row.task_id))) this.tasks.cancel(String(row.task_id), String(row.user_id));
    }
    this.db.prepare("UPDATE channel_inbox SET status='interrupted' WHERE account_id=? AND status IN ('received','running')").run(id);
    this.db.prepare("UPDATE channel_outbox SET status='cancelled',error='渠道已停止' WHERE status='pending' AND inbox_id IN (SELECT id FROM channel_inbox WHERE account_id=?)").run(id);
    this.db.prepare("UPDATE schedule_deliveries SET status='cancelled',error='渠道已停止' WHERE status='pending' AND account_id=?").run(id);
    if (runtime) { await Promise.all([runtime.run, runtime.sending]); this.runtimes.delete(id); }
    this.updateState(id, 'stopped');
  }
  receive(accountId: string, input: InboundMessage) {
    if (this.stopped) return;
    const account = this.account(accountId); if (!account.enabled) return;
    const eventId = boundedString(input.eventId); const senderId = boundedString(input.senderId); const replyContext = boundedString(input.replyContext, 16384);
    const raw = typeof input.text === 'string' ? input.text : '';
    if (raw.length > 65536) return;
    const text = raw.trim();
    if (!account.pairedSender) {
      if (!/^\/bind [A-F0-9]{10}$/.test(text)) return;
      const attempt = this.bindingAttempts.get(accountId);
      const limit = attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 60000 };
      this.bindingAttempts.set(accountId, limit); if (++limit.count > 10) return;
      const pair = this.db.prepare('SELECT pairing_hash,pairing_expires_at FROM channel_accounts WHERE id=?').get(accountId)!;
      if (!pair.pairing_hash || String(pair.pairing_expires_at) <= now() || !timingSafeEqual(Buffer.from(String(pair.pairing_hash), 'hex'), Buffer.from(hash(text.slice(6)), 'hex'))) return;
      this.db.prepare('UPDATE channel_accounts SET paired_sender=?,pairing_hash=NULL,pairing_expires_at=NULL WHERE id=?').run(senderId, accountId);
    } else if (account.pairedSender !== senderId) return;
    const duplicate = this.db.prepare('SELECT id FROM channel_inbox WHERE account_id=? AND event_id=?').get(accountId, eventId);
    if (duplicate) return;
    // 留存上限达到后拒绝新任务，不删除幂等墓碑后重新接受旧事件。
    if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM channel_inbox WHERE account_id=?').get(accountId)!.n) >= 10000) {
      this.updateState(accountId, 'error', '渠道消息记录已达 10000 条上限，请在网页管理渠道'); return;
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO channel_inbox(id,account_id,event_id,sender_id,text,reply_context,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, accountId, eventId, senderId, text.slice(0, 8000), replyContext, 'received', now());
    if (text.startsWith('/bind ')) { this.complete(id, '身份已绑定，可以开始对话。'); return; }
    if (!text || text.length > 8000) { this.complete(id, '目前仅支持 1–8000 字符的纯文本消息，请重新发送。'); return; }
    if (text === '/stop') {
      const active = this.db.prepare("SELECT task_id FROM channel_inbox WHERE account_id=? AND sender_id=? AND status='running' AND task_id IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(accountId, senderId);
      if (active?.task_id && this.tasks.isActive(String(active.task_id))) { this.tasks.cancel(String(active.task_id), account.userId); this.complete(id, '已请求取消当前渠道任务。'); }
      else this.complete(id, '当前渠道没有正在运行的任务。'); return;
    }
    let mapping = this.db.prepare('SELECT conversation_id FROM channel_conversations WHERE account_id=? AND sender_id=?').get(accountId, senderId);
    if (!mapping) {
      const conversationId = randomUUID();
      transaction(this.db, () => {
        this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(conversationId, account.userId, `${account.kind === 'qq' ? 'QQ' : '微信'}机器人私聊`, now());
        this.db.prepare('INSERT INTO channel_conversations VALUES(?,?,?)').run(accountId, senderId, conversationId);
      }); mapping = { conversation_id: conversationId };
    }
    try {
      const taskId = this.tasks.create(account.userId, String(mapping.conversation_id), text, hash(JSON.stringify(['channel', accountId, eventId])));
      this.db.prepare("UPDATE channel_inbox SET task_id=?,status='running' WHERE id=?").run(taskId, id);
    } catch (error) { this.complete(id, error instanceof TaskError ? error.message : '任务创建失败，请在网页查看配置后重试。'); }
  }
  private enqueue(id: string, text: string) {
    const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM channel_outbox WHERE inbox_id=?').get(id)!.n);
    // QQ 被动回复条数有限；总计最多五条，长答案保留在网页。
    const maxParts = 5 - count; if (maxParts <= 0) return;
    const chars = Array.from(text); const limit = maxParts * 1500;
    if (chars.length > limit) { chars.length = limit - 50; chars.push(...'\n回复较长，完整内容请在 MlClaw 网页查看。'); }
    for (let start = 0, part = count + 1; start < chars.length; start += 1500, part++) {
      this.db.prepare('INSERT INTO channel_outbox(id,inbox_id,part,text,status,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), id, part, chars.slice(start, start + 1500).join(''), 'pending', now());
    }
  }
  private complete(id: string, text: string) {
    transaction(this.db, () => { this.enqueue(id, text); this.db.prepare("UPDATE channel_inbox SET status='done' WHERE id=?").run(id); });
  }
  tick() {
    if (this.stopped) return;
    enqueueScheduleDeliveries(this.db);
    for (const row of this.db.prepare("SELECT d.*,o.delivery_target,o.user_id FROM schedule_deliveries d JOIN schedule_occurrences o ON o.id=d.occurrence_id WHERE d.status='pending'").all()) {
      const target = JSON.parse(String(row.delivery_target)) as DeliveryTarget;
      const valid = targetValid(this.db, target, String(row.user_id));
      if (!valid || Date.now() - parseSystemTime(String(row.created_at)) >= 600000) {
        this.db.prepare("UPDATE schedule_deliveries SET status=?,error=? WHERE occurrence_id=?").run(valid ? 'failed' : 'cancelled', valid ? '等待渠道连接超过 10 分钟，未发送' : '渠道已停用、移除或绑定已改变', row.occurrence_id!);
      }
    }
    for (const row of this.db.prepare("SELECT i.*,t.status AS task_status,t.error AS task_error FROM channel_inbox i LEFT JOIN tasks t ON t.id=i.task_id WHERE i.status='running'").all()) {
      if (row.task_status === 'waiting_approval' && !row.approval_notified) {
        transaction(this.db, () => { this.enqueue(String(row.id), '此操作需要批准。请打开 MlClaw 网页中的对应渠道会话，核对参数后批准或拒绝。任务总时限为 120 秒，超时后批准失效。'); this.db.prepare('UPDATE channel_inbox SET approval_notified=1 WHERE id=?').run(row.id!); });
      }
      if (row.task_status && ['queued', 'running', 'waiting_approval'].includes(String(row.task_status))) continue;
      if (row.task_status === 'succeeded') {
        const events = this.db.prepare("SELECT data FROM task_events WHERE task_id=? AND type='message.delta' ORDER BY seq").all(row.task_id!);
        this.complete(String(row.id), events.map(e => String((JSON.parse(String(e.data)) as { text: string }).text)).join('') || '任务已完成，无文本回复。');
      } else this.complete(String(row.id), row.task_status === 'cancelled' ? '任务已取消。' : row.task_status === 'interrupted' ? '服务重启，任务已中断，请手动重新发送。' : '任务未完成，请在 MlClaw 网页查看详情。');
    }
    for (const [id, runtime] of this.runtimes) {
      if (runtime.sending || runtime.controller.signal.aborted || this.states.get(id)?.state !== 'connected') continue;
      const row = this.db.prepare(`SELECT o.*,i.event_id,i.sender_id,i.reply_context FROM channel_outbox o JOIN channel_inbox i ON i.id=o.inbox_id
        WHERE i.account_id=? AND o.status='pending' AND NOT EXISTS (SELECT 1 FROM channel_outbox p WHERE p.inbox_id=o.inbox_id AND p.part<o.part AND p.status<>'sent') ORDER BY o.rowid LIMIT 1`).get(id);
      if (row) runtime.sending = this.deliver(runtime, row).catch(() => {
        this.updateState(id, 'error', '投递记录保存失败，渠道已停止，请检查数据库状态'); runtime.controller.abort();
      }).finally(() => { runtime.sending = undefined; });
      else {
        const scheduled = this.db.prepare("SELECT d.*,o.delivery_target,o.user_id FROM schedule_deliveries d JOIN schedule_occurrences o ON o.id=d.occurrence_id WHERE d.account_id=? AND d.status='pending' ORDER BY d.rowid LIMIT 1").get(id);
        if (scheduled) runtime.sending = this.deliverScheduled(runtime, scheduled).catch(() => {
          this.updateState(id, 'error', '定时投递记录保存失败，渠道已停止'); runtime.controller.abort();
        }).finally(() => { runtime.sending = undefined; });
      }
    }
  }
  private updateState(id: string, state: ChannelAccountView['state'], message = '') {
    const previous = this.states.get(id);
    this.states.set(id, { state, message });
    if (previous?.state === state || !previous && state === 'stopped') return;
    try {
      const account = this.account(id);
      const level = state === 'error' || state === 'expired' ? 'error' : previous?.state === 'connected' && state !== 'stopped' ? 'warning' : 'info';
      const label = account.kind === 'qq' ? 'QQ' : '微信';
      const descriptions: Record<ChannelAccountView['state'], string> = { stopped: `${label}渠道已停止`, connecting: `${label}渠道正在连接`, connected: `${label}渠道已连接`, error: `${label}渠道连接异常`, expired: `${label}渠道登录已失效` };
      this.logs?.record(account.userId, { level, source: 'channel', event: `channel.${state}`, message: descriptions[state], entity: { type: 'channel', id }, metadata: { channelKind: account.kind } });
    } catch { /* 账号删除后的最终状态无需再记录。 */ }
  }
  private async deliverScheduled(runtime: Runtime, row: Row) {
    const target = JSON.parse(String(row.delivery_target)) as DeliveryTarget;
    if (runtime.controller.signal.aborted || !targetValid(this.db, target, String(row.user_id))) {
      this.db.prepare("UPDATE schedule_deliveries SET status='cancelled',error='渠道授权已撤销' WHERE occurrence_id=?").run(row.occurrence_id!); return;
    }
    // 微信沿用该本人最近一次真实入站上下文；QQ 使用独立主动消息，不能复用旧消息序号。
    const context = target.kind === 'weixin' ? this.db.prepare('SELECT reply_context FROM channel_inbox WHERE account_id=? AND sender_id=? ORDER BY rowid DESC LIMIT 1').get(target.accountId, target.senderId) : null;
    if (target.kind === 'weixin' && !context?.reply_context) {
      this.db.prepare("UPDATE schedule_deliveries SET status='failed',error='缺少微信会话上下文，请先向机器人发送一条消息，再手动运行计划' WHERE occurrence_id=?").run(row.occurrence_id!); return;
    }
    this.db.prepare("UPDATE schedule_deliveries SET status='sending' WHERE occurrence_id=? AND status='pending'").run(row.occurrence_id!);
    try {
      await runtime.transport.send({ id: String(row.occurrence_id), eventId: '', part: 1, senderId: target.senderId,
        replyContext: String(context?.reply_context ?? ''), text: String(row.text), proactive: true }, runtime.controller.signal);
      this.db.prepare("UPDATE schedule_deliveries SET status='sent',error=NULL WHERE occurrence_id=?").run(row.occurrence_id!);
    } catch (error) {
      this.db.prepare('UPDATE schedule_deliveries SET status=?,error=? WHERE occurrence_id=?').run(error instanceof DeliveryError ? error.outcome : 'unknown',
        target.kind === 'qq' ? 'QQ 未确认发送，请核对收件及机器人主动消息权限；不会自动重发' : '微信未确认发送，请核对收件；可向机器人发送消息更新上下文后手动运行，旧结果不会自动重发', row.occurrence_id!);
      this.logs?.record(String(row.user_id), { level: 'error', source: 'channel', event: 'channel.schedule_delivery_failed', message: `${target.kind === 'qq' ? 'QQ' : '微信'}定时消息投递失败或结果未知`, entity: { type: 'occurrence', id: String(row.occurrence_id) }, metadata: { channelKind: target.kind, status: error instanceof DeliveryError ? error.outcome : 'unknown' } });
    }
  }
  private async deliver(runtime: Runtime, row: Row) {
    this.db.prepare("UPDATE channel_outbox SET status='sending' WHERE id=?").run(row.id!);
    try {
      await runtime.transport.send({ id: String(row.id), part: Number(row.part), text: String(row.text), eventId: String(row.event_id), senderId: String(row.sender_id), replyContext: String(row.reply_context) }, runtime.controller.signal);
      this.db.prepare("UPDATE channel_outbox SET status='sent',error=NULL WHERE id=?").run(row.id!);
    } catch (error) {
      this.db.prepare('UPDATE channel_outbox SET status=?,error=? WHERE id=?').run(error instanceof DeliveryError ? error.outcome : 'unknown', '平台未确认投递结果；请到原聊天核对。后续分段已暂停，不会重新执行任务。', row.id!);
      const account = this.account(String(this.db.prepare('SELECT account_id FROM channel_inbox WHERE id=?').get(row.inbox_id!)!.account_id));
      this.logs?.record(account.userId, { level: 'error', source: 'channel', event: 'channel.delivery_failed', message: `${account.kind === 'qq' ? 'QQ' : '微信'}消息投递失败或结果未知`, entity: { type: 'channel', id: account.id }, metadata: { channelKind: account.kind, status: error instanceof DeliveryError ? error.outcome : 'unknown' } });
    }
  }
  async close() {
    this.stopped = true; clearInterval(this.timer); this.timer = undefined;
    await Promise.all([...this.runtimes.keys()].map(id => this.disconnect(id)));
  }
}
