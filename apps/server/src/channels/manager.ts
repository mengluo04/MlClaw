import { EmailTransport, validateEmailConfig } from './email.js';
import { formatSystemTime, parseSystemTime } from '../time.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
  ChannelAccountView,
  ChannelKind,
  ChannelSettings,
  WebhookConfigInput,
  EmailConfigInput,
} from '@mlclaw/shared';
import { TaskError, type TaskManager } from '../tasks/manager.js';
import { transaction } from '../db/index.js';
import { savedTaskText } from '../tasks/output.js';
import {
  boundedString,
  ChannelError,
  DeliveryError,
  type ChannelAccount,
  type ChannelTransport,
  type InboundMessage,
  type TransportFactory,
} from './types.js';
import { QQTransport } from './qq.js';
import { WeixinTransport } from './weixin.js';
import {
  WebhookTransport,
  validateWebhookUrl,
  defaultWebhookConfig,
  resolveWebhookConfig,
} from './webhook.js';
import {
  enqueueScheduleDeliveries,
  targetValid,
  type DeliveryTarget,
} from '../schedules/delivery.js';
import type { SystemLogService } from '../system-logs/service.js';

/** 计算用于校验的数据哈希。 */
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** 返回当前流程使用的时间。 */
const now = () => formatSystemTime();
type Row = Record<string, SQLOutputValue>;
interface Runtime {
  controller: AbortController;
  transport: ChannelTransport;
  run: Promise<void>;
  sending?: Promise<void>;
}
/** 按渠道类型创建传输实现。 */
const defaultFactory: TransportFactory = (account, sink) =>
  account.kind === 'email'
    ? new EmailTransport(account, sink)
    : account.kind === 'webhook'
      ? new WebhookTransport(account, sink)
      : account.kind === 'qq'
        ? new QQTransport(account, sink)
        : new WeixinTransport(account, sink);

export class ChannelManager {
  /** 按渠道账号保存的连接运行实例。 */
  private runtimes = new Map<string, Runtime>();
  /** 按渠道保存的连接状态与提示。 */
  private states = new Map<string, Pick<ChannelAccountView, 'state' | 'message'>>();
  /** 延迟执行或超时控制的定时器句柄。 */
  private timer?: ReturnType<typeof setInterval>;
  /** 是否已经停止。 */
  private stopped = false;
  /** 正在修改的渠道键集合，用于阻止并发更新。 */
  private mutations = new Set<string>();
  /** 各账号绑定尝试的限流计数。 */
  private bindingAttempts = new Map<string, { count: number; until: number }>();
  constructor(
    readonly db: DatabaseSync,
    private tasks: TaskManager,
    private factory: TransportFactory = defaultFactory,
    private logs?: SystemLogService,
  ) {
    // 已启动任务由 TaskManager 标为 interrupted；渠道绝不重放旧入站或不明投递。
    db.exec(
      "UPDATE channel_inbox SET status='interrupted' WHERE status IN ('received','running'); UPDATE channel_outbox SET status='unknown',error='服务重启，投递结果未确认，请到原聊天核对' WHERE status='sending'; UPDATE channel_outbox SET status='cancelled',error='服务重启，未自动投递旧回复' WHERE status='pending';",
    );
    enqueueScheduleDeliveries(db, true);
    db.exec(
      "UPDATE schedule_deliveries SET status='unknown',error='服务重启，投递结果未确认，不自动重发' WHERE status='sending'; UPDATE schedule_deliveries SET status='cancelled',error='服务重启，不自动投递旧结果' WHERE status='pending';",
    );
  }
  /** 启动当前服务或状态订阅。 */
  start() {
    if (this.timer || this.stopped) return;
    for (/* 逐项处理当前数据库记录。 */ const row of this.db
      .prepare('SELECT id FROM channel_accounts WHERE enabled=1')
      .all())
      this.connect(String(row.id));
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        for (/* 逐项处理当前记录标识。 */ const id of this.runtimes.keys())
          this.updateState(id, 'error', '渠道事件处理失败，请检查数据库状态');
      }
    }, 250);
    this.timer.unref();
  }
  /** 按账号标识读取渠道配置，可同时校验用户归属。 */
  account(id: string, userId?: string): ChannelAccount {
    /** channel_accounts 表的查询记录。 */
    const row = userId
      ? this.db.prepare('SELECT * FROM channel_accounts WHERE id=? AND user_id=?').get(id, userId)
      : this.db.prepare('SELECT * FROM channel_accounts WHERE id=?').get(id);
    if (!row) throw new ChannelError('渠道不存在', 404);
    return {
      id: String(row.id),
      userId: String(row.user_id),
      kind: row.kind as ChannelKind,
      remoteId: String(row.remote_id),
      secret: String(row.secret),
      baseUrl: String(row.base_url),
      enabled: !!row.enabled,
      cursor: String(row.cursor),
      ...(row.kind === 'email' && row.email_config
        ? { email: JSON.parse(String(row.email_config)) }
        : {}),
      pairedSender: row.paired_sender === null ? null : String(row.paired_sender),
      ...(row.kind === 'webhook'
        ? {
            webhook: row.webhook_config
              ? JSON.parse(String(row.webhook_config))
              : defaultWebhookConfig(String(row.secret)),
          }
        : {}),
    };
  }
  /** 将内部记录映射为对外展示结构。 */
  view(userId: string): ChannelSettings {
    /** 当前渠道账号集合。 */
    const accounts = this.db
      .prepare('SELECT id FROM channel_accounts WHERE user_id=? ORDER BY kind')
      .all(userId)
      .map((row) => {
        /** 待转换为公开展示结构的渠道账号。 */
        const a = this.account(String(row.id), userId);
        return {
          displayName:
            (
              { qq: 'QQ', weixin: '微信', webhook: 'Webhook', email: '邮箱' } as Record<
                string,
                string
              >
            )[a.kind] ?? a.kind,
          scheduleDelivery: {
            available: a.enabled && !!a.pairedSender,
            statusLabel: !a.enabled
              ? '已停用'
              : !a.pairedSender
                ? '未绑定'
                : a.kind === 'webhook' || a.kind === 'email'
                  ? '接收地址已配置'
                  : '已绑定本人',
          },
          ...(a.email ? { email: a.email } : {}),
          id: a.id,
          kind: a.kind,
          remoteId: a.remoteId,
          enabled: a.enabled,
          hasCredential: a.webhook
            ? Object.keys(a.webhook.headers).some((key) => key !== 'content-type')
            : !!a.secret,
          ...(a.webhook
            ? {
                webhook: {
                  method: a.webhook.method,
                  headerNames: Object.keys(a.webhook.headers),
                  bodyTemplate: a.webhook.bodyTemplate,
                },
              }
            : {}),
          pairedSender: a.pairedSender,
          ...(this.states.get(a.id) ?? { state: 'stopped' as const, message: '' }),
        };
      });
    return { accounts };
  }
  /** 按渠道键阻止并发配置修改，结束后释放修改标记。 */
  async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new ChannelError('服务正在关闭', 503);
    if (this.mutations.has(key)) throw new ChannelError('渠道正在更新，请稍后重试', 409);
    this.mutations.add(key);
    try {
      return await operation();
    } finally {
      this.mutations.delete(key);
    }
  }
  /** 更新运行时使用的配置。 */
  async configure(
    userId: string,
    kind: ChannelKind,
    remoteId: string,
    secret: string | undefined,
    baseUrl = '',
    webhookInput: WebhookConfigInput = {},
  ) {
    return this.exclusive(`${userId}:${kind}`, async () => {
      /** channel_accounts 表的查询记录。 */
      const previous = this.db
        .prepare('SELECT id FROM channel_accounts WHERE user_id=? AND kind=?')
        .get(userId, kind);
      /** 原有记录或状态。 */
      const old = previous ? this.account(String(previous.id), userId) : undefined;
      if (kind === 'webhook') baseUrl = validateWebhookUrl(baseUrl || old?.baseUrl || '');
      /** Webhook 接收地址是否变化，用于决定能否复用令牌。 */
      const changedWebhookUrl = kind === 'webhook' && old && baseUrl !== old.baseUrl;
      /** 认证凭据数据。 */
      const credential =
        secret ?? (old?.remoteId === remoteId && !changedWebhookUrl ? old.secret : '');
      if (
        (kind !== 'webhook' && !credential) ||
        credential.length > 4096 ||
        /[\s\u0000-\u001f]/.test(credential)
      )
        throw new ChannelError('请填写有效的渠道凭据');
      /** 旧 token 接口映射到 Authorization；新 Headers 配置覆盖完整 Header 集合。 */
      if (kind === 'webhook' && secret !== undefined && webhookInput.headers === undefined) {
        const headers = {
          ...(changedWebhookUrl
            ? defaultWebhookConfig().headers
            : (old?.webhook?.headers ?? defaultWebhookConfig().headers)),
        };
        delete headers.authorization;
        if (secret) headers.authorization = `Bearer ${secret}`;
        webhookInput = { ...webhookInput, headers };
      }
      const webhookConfig =
        kind === 'webhook'
          ? resolveWebhookConfig(
              webhookInput,
              old?.webhook ?? defaultWebhookConfig(credential),
              !!changedWebhookUrl,
            )
          : undefined;
      if (old) await this.disconnect(old.id);
      /** 当前记录标识。 */
      const id = old?.remoteId === remoteId ? old.id : randomUUID();
      transaction(this.db, () => {
        if (old && old.id !== id)
          this.db.prepare('DELETE FROM channel_accounts WHERE id=?').run(old.id);
        this.db
          .prepare(
            `INSERT INTO channel_accounts(id,user_id,kind,remote_id,secret,base_url,created_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,base_url=excluded.base_url,enabled=0,cursor='',pairing_hash=NULL,pairing_expires_at=NULL`,
          )
          .run(id, userId, kind, remoteId, kind === 'webhook' ? '' : credential, baseUrl, now());
        if (kind === 'webhook')
          this.db
            .prepare(
              "UPDATE channel_accounts SET paired_sender='webhook',binding_version=binding_version+1,webhook_config=? WHERE id=?",
            )
            .run(JSON.stringify(webhookConfig), id);
      });
      this.updateState(id, 'stopped');
      this.logs?.record(userId, {
        level: 'info',
        source: 'channel',
        event: 'channel.configured',
        message: `${kind === 'qq' ? 'QQ' : kind === 'webhook' ? 'Webhook' : '微信'}渠道配置已保存`,
        entity: { type: 'channel', id },
        metadata: { channelKind: kind },
      });
      return { id };
    });
  }
  async configureEmail(userId: string, input: EmailConfigInput) {
    return this.exclusive(`${userId}:email`, async () => {
      const config = validateEmailConfig(input);
      const row = this.db
        .prepare("SELECT id FROM channel_accounts WHERE user_id=? AND kind='email'")
        .get(userId);
      const old = row ? this.account(String(row.id), userId) : undefined;
      const sameIdentity =
        old?.email &&
        ['host', 'port', 'security', 'username'].every(
          (key) => old.email![key as keyof typeof config] === config[key as keyof typeof config],
        );
      const password = input.password ?? (sameIdentity ? old?.secret : undefined);
      if (
        typeof password !== 'string' ||
        !password.length ||
        password.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(password)
      )
        throw new ChannelError(
          '请填写 SMTP 密码或授权码；更换服务器、端口、加密方式或账号须重新填写',
        );
      if (old) await this.disconnect(old.id);
      const id = old?.id ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO channel_accounts(id,user_id,kind,remote_id,secret,paired_sender,email_config,created_at,binding_version)
        VALUES(?,?,'email','邮箱',?,'email',?,?,1)
        ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,email_config=excluded.email_config,
          enabled=0,binding_version=binding_version+1`,
        )
        .run(id, userId, password, JSON.stringify(config), now());
      this.updateState(id, 'stopped');
      this.logs?.record(userId, {
        level: 'info',
        source: 'channel',
        event: 'channel.configured',
        message: '邮箱渠道配置已保存',
        entity: { type: 'channel', id },
        metadata: { channelKind: 'email' },
      });
      return { id };
    });
  }
  /** 设置记录的启用状态。 */
  async enable(id: string, userId: string, enabled: boolean) {
    /** 当前渠道账号。 */
    const account = this.account(id, userId);
    await this.exclusive(`${userId}:${account.kind}`, async () => {
      await this.disconnect(id);
      this.db.prepare('UPDATE channel_accounts SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
      if (enabled) this.connect(id);
      this.logs?.record(userId, {
        level: 'info',
        source: 'channel',
        event: enabled ? 'channel.enabled' : 'channel.disabled',
        message: `${account.kind === 'email' ? '邮箱' : account.kind === 'qq' ? 'QQ' : account.kind === 'webhook' ? 'Webhook' : '微信'}渠道已${enabled ? '启用' : '停用'}`,
        entity: { type: 'channel', id },
        metadata: { channelKind: account.kind },
      });
    });
  }
  /** 删除指定记录并更新当前列表。 */
  async remove(id: string, userId: string) {
    /** 当前渠道账号。 */
    const account = this.account(id, userId);
    await this.exclusive(`${userId}:${account.kind}`, async () => {
      await this.disconnect(id);
      this.logs?.record(userId, {
        level: 'info',
        source: 'channel',
        event: 'channel.removed',
        message: `${account.kind === 'email' ? '邮箱' : account.kind === 'qq' ? 'QQ' : account.kind === 'webhook' ? 'Webhook' : '微信'}渠道已移除`,
        entity: { type: 'channel', id },
        metadata: { channelKind: account.kind },
      });
      this.db.prepare('DELETE FROM channel_accounts WHERE id=?').run(id);
      this.states.delete(id);
      this.bindingAttempts.delete(id);
    });
  }
  /** 生成当前账号的身份绑定码。 */
  pairCode(id: string, userId: string) {
    /** 当前渠道账号。 */
    const account = this.account(id, userId);
    if (account.kind === 'webhook' || account.kind === 'email')
      throw new ChannelError('出站渠道使用管理员配置的接收地址，无需身份绑定');
    if (account.pairedSender) throw new ChannelError('请先解除已有身份绑定', 409);
    /** 当前消息中的协议代码或验证码。 */
    const code = randomBytes(5).toString('hex').toUpperCase();
    /** 缓存访问令牌的过期时间。 */
    const expiresAt = formatSystemTime(new Date(Date.now() + 300000));
    this.db
      .prepare('UPDATE channel_accounts SET pairing_hash=?,pairing_expires_at=? WHERE id=?')
      .run(hash(code), expiresAt, id);
    return { code, expiresAt, expiresInSeconds: 300 };
  }
  /** 撤销渠道绑定并失效旧投递目标。 */
  async unpair(id: string, userId: string) {
    /** 当前渠道账号。 */
    const account = this.account(id, userId);
    if (account.kind === 'webhook' || account.kind === 'email')
      throw new ChannelError('出站渠道无需身份绑定，请停止或移除渠道');
    await this.exclusive(`${userId}:${account.kind}`, async () => {
      await this.disconnect(id);
      this.db
        .prepare(
          'UPDATE channel_accounts SET enabled=0,paired_sender=NULL,pairing_hash=NULL,pairing_expires_at=NULL,binding_version=binding_version+1 WHERE id=?',
        )
        .run(id);
      // 新绑定不能继承之前身份的会话映射；原历史仍可在网页查看。
      this.db.prepare('DELETE FROM channel_conversations WHERE account_id=?').run(id);
    });
  }
  /** 建立连接并注册消息与断开处理。 */
  private connect(id: string) {
    if (this.stopped || this.runtimes.has(id)) return;
    /** 当前渠道账号。 */
    const account = this.account(id);
    /** 用于主动取消当前操作的控制器。 */
    const controller = new AbortController();
    this.updateState(id, 'connecting');
    /** 当前渠道传输实现。 */
    const transport = this.factory(account, {
      receive: (message) => {
        if (!controller.signal.aborted) this.receive(id, message);
      },
      cursor: (value) => {
        if (!controller.signal.aborted)
          this.db.prepare('UPDATE channel_accounts SET cursor=? WHERE id=?').run(value, id);
      },
      state: (state, message = '') => {
        if (!controller.signal.aborted) this.updateState(id, state, message);
      },
    });
    /** 当前渠道的传输实例、取消控制器与待发队列。 */
    const runtime: Runtime = { controller, transport, run: Promise.resolve() };
    this.runtimes.set(id, runtime);
    runtime.run = Promise.resolve()
      .then(() => transport.run(controller.signal))
      .catch(() => {
        if (!controller.signal.aborted)
          this.updateState(id, 'error', '渠道连接失败，请检查凭据和平台权限后重新连接');
      });
  }
  /** 断开连接并释放相关资源。 */
  private async disconnect(id: string) {
    /** 当前渠道的传输实例、取消控制器与待发队列。 */
    const runtime = this.runtimes.get(id);
    runtime?.controller.abort();
    for (/* 逐项处理当前数据库记录。 */ const row of this.db
      .prepare(
        "SELECT i.task_id,a.user_id FROM channel_inbox i JOIN channel_accounts a ON a.id=i.account_id WHERE i.account_id=? AND i.status='running'",
      )
      .all(id)) {
      if (row.task_id && this.tasks.isActive(String(row.task_id)))
        this.tasks.cancel(String(row.task_id), String(row.user_id));
    }
    this.db
      .prepare(
        "UPDATE channel_inbox SET status='interrupted' WHERE account_id=? AND status IN ('received','running')",
      )
      .run(id);
    this.db
      .prepare(
        "UPDATE channel_outbox SET status='cancelled',error='渠道已停止' WHERE status='pending' AND inbox_id IN (SELECT id FROM channel_inbox WHERE account_id=?)",
      )
      .run(id);
    this.db
      .prepare(
        "UPDATE schedule_deliveries SET status='cancelled',error='渠道已停止' WHERE status='pending' AND account_id=?",
      )
      .run(id);
    if (runtime) {
      await Promise.all([runtime.run, runtime.sending]);
      this.runtimes.delete(id);
    }
    this.updateState(id, 'stopped');
  }
  /** 处理入站消息并执行去重和身份校验。 */
  receive(accountId: string, input: InboundMessage) {
    if (this.stopped) return;
    /** 当前渠道账号。 */
    const account = this.account(accountId);
    if (!account.enabled || account.kind === 'webhook' || account.kind === 'email') return;
    /** 事件标识，用于去重或续传。 */
    const eventId = boundedString(input.eventId);
    /** 渠道消息发送者标识。 */
    const senderId = boundedString(input.senderId);
    /** reply上下文数据。 */
    const replyContext = boundedString(input.replyContext, 16384);
    /** 尚未规范化的原始数据。 */
    const raw = typeof input.text === 'string' ? input.text : '';
    if (raw.length > 65536) return;
    /** 当前处理的文本。 */
    const text = raw.trim();
    if (!account.pairedSender) {
      if (!/^\/bind [A-F0-9]{10}$/.test(text)) return;
      /** 当前尝试序号。 */
      const attempt = this.bindingAttempts.get(accountId);
      /** 当前处理上限。 */
      const limit =
        attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 60000 };
      this.bindingAttempts.set(accountId, limit);
      if (++limit.count > 10) return;
      /** 配对数据。 */
      const pair = this.db
        .prepare('SELECT pairing_hash,pairing_expires_at FROM channel_accounts WHERE id=?')
        .get(accountId)!;
      if (
        !pair.pairing_hash ||
        String(pair.pairing_expires_at) <= now() ||
        !timingSafeEqual(
          Buffer.from(String(pair.pairing_hash), 'hex'),
          Buffer.from(hash(text.slice(6)), 'hex'),
        )
      )
        return;
      this.db
        .prepare(
          'UPDATE channel_accounts SET paired_sender=?,pairing_hash=NULL,pairing_expires_at=NULL WHERE id=?',
        )
        .run(senderId, accountId);
    } else if (account.pairedSender !== senderId) return;
    /** 重复数据。 */
    const duplicate = this.db
      .prepare('SELECT id FROM channel_inbox WHERE account_id=? AND event_id=?')
      .get(accountId, eventId);
    if (duplicate) return;
    // 留存上限达到后拒绝新任务，不删除幂等墓碑后重新接受旧事件。
    if (
      Number(
        this.db
          .prepare('SELECT COUNT(*) AS n FROM channel_inbox WHERE account_id=?')
          .get(accountId)!.n,
      ) >= 10000
    ) {
      this.updateState(accountId, 'error', '渠道消息记录已达 10000 条上限，请在网页管理渠道');
      return;
    }
    /** 当前记录标识。 */
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO channel_inbox(id,account_id,event_id,sender_id,text,reply_context,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(id, accountId, eventId, senderId, text.slice(0, 8000), replyContext, 'received', now());
    if (text.startsWith('/bind ')) {
      this.complete(id, '身份已绑定，可以开始对话。');
      return;
    }
    if (!text || text.length > 8000) {
      this.complete(id, '目前仅支持 1–8000 字符的纯文本消息，请重新发送。');
      return;
    }
    if (text === '/stop') {
      /** 是否存在活动中的任务或对象。 */
      const active = this.db
        .prepare(
          "SELECT task_id FROM channel_inbox WHERE account_id=? AND sender_id=? AND status='running' AND task_id IS NOT NULL ORDER BY rowid DESC LIMIT 1",
        )
        .get(accountId, senderId);
      if (active?.task_id && this.tasks.isActive(String(active.task_id))) {
        this.tasks.cancel(String(active.task_id), account.userId);
        this.complete(id, '已请求取消当前渠道任务。');
      } else this.complete(id, '当前渠道没有正在运行的任务。');
      return;
    }
    /** 内部值到响应状态或业务对象的映射。 */
    let mapping = this.db
      .prepare(
        'SELECT conversation_id FROM channel_conversations WHERE account_id=? AND sender_id=?',
      )
      .get(accountId, senderId);
    if (!mapping) {
      /** 当前会话标识。 */
      const conversationId = randomUUID();
      transaction(this.db, () => {
        this.db
          .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
          .run(
            conversationId,
            account.userId,
            `${account.kind === 'email' ? '邮箱' : account.kind === 'qq' ? 'QQ' : account.kind === 'webhook' ? 'Webhook' : '微信'}机器人私聊`,
            now(),
          );
        this.db
          .prepare('INSERT INTO channel_conversations VALUES(?,?,?)')
          .run(accountId, senderId, conversationId);
      });
      mapping = { conversation_id: conversationId };
    }
    try {
      /** 当前任务标识。 */
      const taskId = this.tasks.create(
        account.userId,
        String(mapping.conversation_id),
        text,
        hash(JSON.stringify(['channel', accountId, eventId])),
      );
      this.db
        .prepare("UPDATE channel_inbox SET task_id=?,status='running' WHERE id=?")
        .run(taskId, id);
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      this.complete(
        id,
        error instanceof TaskError ? error.message : '任务创建失败，请在网页查看配置后重试。',
      );
    }
  }
  /** 将待执行工作加入队列。 */
  private enqueue(id: string, text: string) {
    /** 当前统计数量。 */
    const count = Number(
      this.db.prepare('SELECT COUNT(*) AS n FROM channel_outbox WHERE inbox_id=?').get(id)!.n,
    );
    // QQ 被动回复条数有限；总计最多五条，长答案保留在网页。
    const maxParts = 5 - count;
    if (maxParts <= 0) return;
    /** 本次处理的字符数量。 */
    const chars = Array.from(text);
    /** 当前处理上限。 */
    const limit = maxParts * 1500;
    if (chars.length > limit) {
      chars.length = limit - 50;
      chars.push(...'\n回复较长，完整内容请在 MlClaw 网页查看。');
    }
    for (
      /* 逐项处理本次处理的起始位置或时间、片段。 */ let start = 0, part = count + 1;
      start < chars.length;
      start += 1500, part++
    ) {
      this.db
        .prepare(
          'INSERT INTO channel_outbox(id,inbox_id,part,text,status,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(randomUUID(), id, part, chars.slice(start, start + 1500).join(''), 'pending', now());
    }
  }
  /** 将回复加入出站队列并标记入站消息处理完成。 */
  private complete(id: string, text: string) {
    transaction(this.db, () => {
      this.enqueue(id, text);
      this.db.prepare("UPDATE channel_inbox SET status='done' WHERE id=?").run(id);
    });
  }
  /** 处理已绑定渠道的入站任务及待发送回复、定时投递。 */
  tick() {
    if (this.stopped) return;
    enqueueScheduleDeliveries(this.db);
    for (/* 逐项处理当前数据库记录。 */ const row of this.db
      .prepare(
        "SELECT d.*,o.delivery_target,o.user_id FROM schedule_deliveries d JOIN schedule_occurrences o ON o.id=d.occurrence_id WHERE d.status='pending'",
      )
      .all()) {
      /** 本次处理的目标。 */
      const target = JSON.parse(String(row.delivery_target)) as DeliveryTarget;
      /** 当前数据是否通过有效性校验。 */
      const valid = targetValid(this.db, target, String(row.user_id));
      if (!valid || Date.now() - parseSystemTime(String(row.created_at)) >= 600000) {
        this.db
          .prepare('UPDATE schedule_deliveries SET status=?,error=? WHERE occurrence_id=?')
          .run(
            valid ? 'failed' : 'cancelled',
            valid ? '等待渠道连接超过 10 分钟，未发送' : '渠道已停用、移除或绑定已改变',
            row.occurrence_id!,
          );
      }
    }
    for (/* 逐项处理当前数据库记录。 */ const row of this.db
      .prepare(
        "SELECT i.*,t.status AS task_status,t.error AS task_error FROM channel_inbox i LEFT JOIN tasks t ON t.id=i.task_id WHERE i.status='running'",
      )
      .all()) {
      if (
        row.task_status &&
        ['queued', 'running', 'waiting_approval'].includes(String(row.task_status))
      )
        continue;
      if (row.task_status === 'succeeded') {
        this.complete(
          String(row.id),
          savedTaskText(this.db, String(row.task_id)) || '任务已完成，无文本回复。',
        );
      } else
        this.complete(
          String(row.id),
          row.task_status === 'cancelled'
            ? '任务已取消。'
            : row.task_status === 'interrupted'
              ? '服务重启，任务已中断，请手动重新发送。'
              : '任务未完成，请在 MlClaw 网页查看详情。',
        );
    }
    for (/* 逐项处理当前记录标识、当前活动任务的运行信息。 */ const [id, runtime] of this
      .runtimes) {
      if (
        runtime.sending ||
        runtime.controller.signal.aborted ||
        this.states.get(id)?.state !== 'connected'
      )
        continue;
      /** channel_outbox 表的查询记录。 */
      const row = this.db
        .prepare(
          `SELECT o.*,i.event_id,i.sender_id,i.reply_context FROM channel_outbox o JOIN channel_inbox i ON i.id=o.inbox_id
        WHERE i.account_id=? AND o.status='pending' AND NOT EXISTS (SELECT 1 FROM channel_outbox p WHERE p.inbox_id=o.inbox_id AND p.part<o.part AND p.status<>'sent') ORDER BY o.rowid LIMIT 1`,
        )
        .get(id);
      if (row)
        runtime.sending = this.deliver(runtime, row)
          .catch(() => {
            this.updateState(id, 'error', '投递记录保存失败，渠道已停止，请检查数据库状态');
            runtime.controller.abort();
          })
          .finally(() => {
            runtime.sending = undefined;
          });
      else {
        /** 当前待发送的定时任务投递记录。 */
        const scheduled = this.db
          .prepare(
            "SELECT d.*,o.delivery_target,o.user_id FROM schedule_deliveries d JOIN schedule_occurrences o ON o.id=d.occurrence_id WHERE d.account_id=? AND d.status='pending' ORDER BY d.rowid LIMIT 1",
          )
          .get(id);
        if (scheduled)
          runtime.sending = this.deliverScheduled(runtime, scheduled)
            .catch(() => {
              this.updateState(id, 'error', '定时投递记录保存失败，渠道已停止');
              runtime.controller.abort();
            })
            .finally(() => {
              runtime.sending = undefined;
            });
      }
    }
  }
  /** 同步当前运行状态并通知观察方。 */
  private updateState(id: string, state: ChannelAccountView['state'], message = '') {
    /** 修改前的数据。 */
    const previous = this.states.get(id);
    this.states.set(id, { state, message });
    if (previous?.state === state || (!previous && state === 'stopped')) return;
    try {
      /** 当前渠道账号。 */
      const account = this.account(id);
      /** 当前日志等级。 */
      const level =
        state === 'error' || state === 'expired'
          ? 'error'
          : previous?.state === 'connected' && state !== 'stopped'
            ? 'warning'
            : 'info';
      /** 界面展示标签。 */
      const label =
        account.kind === 'email'
          ? '邮箱'
          : account.kind === 'qq'
            ? 'QQ'
            : account.kind === 'webhook'
              ? 'Webhook'
              : '微信';
      /** 渠道连接状态对应的系统日志说明。 */
      const descriptions: Record<ChannelAccountView['state'], string> = {
        stopped: `${label}渠道已停止`,
        connecting: `${label}渠道正在连接`,
        connected: `${label}渠道已连接`,
        error: `${label}渠道连接异常`,
        expired: `${label}渠道登录已失效`,
      };
      this.logs?.record(account.userId, {
        level,
        source: 'channel',
        event: `channel.${state}`,
        message: descriptions[state],
        entity: { type: 'channel', id },
        metadata: { channelKind: account.kind },
      });
    } catch {
      /* 账号删除后的最终状态无需再记录。 */
    }
  }
  /** 发送定时任务结果并更新独立投递状态。 */
  private async deliverScheduled(runtime: Runtime, row: Row) {
    /** 本次处理的目标。 */
    const target = JSON.parse(String(row.delivery_target)) as DeliveryTarget;
    if (runtime.controller.signal.aborted || !targetValid(this.db, target, String(row.user_id))) {
      this.db
        .prepare(
          "UPDATE schedule_deliveries SET status='cancelled',error='渠道授权已撤销' WHERE occurrence_id=?",
        )
        .run(row.occurrence_id!);
      return;
    }
    // 微信沿用该本人最近一次真实入站上下文；QQ 使用独立主动消息，不能复用旧消息序号。
    const context =
      target.kind === 'weixin'
        ? this.db
            .prepare(
              'SELECT reply_context FROM channel_inbox WHERE account_id=? AND sender_id=? ORDER BY rowid DESC LIMIT 1',
            )
            .get(target.accountId, target.senderId)
        : null;
    if (target.kind === 'weixin' && !context?.reply_context) {
      this.db
        .prepare(
          "UPDATE schedule_deliveries SET status='failed',error='缺少微信会话上下文，请先向机器人发送一条消息，再手动运行计划' WHERE occurrence_id=?",
        )
        .run(row.occurrence_id!);
      return;
    }
    this.db
      .prepare(
        "UPDATE schedule_deliveries SET status='sending' WHERE occurrence_id=? AND status='pending'",
      )
      .run(row.occurrence_id!);
    try {
      await runtime.transport.send(
        {
          id: String(row.occurrence_id),
          eventId: '',
          part: 1,
          senderId: target.senderId,
          replyContext: String(context?.reply_context ?? ''),
          text: String(row.text),
          proactive: true,
        },
        runtime.controller.signal,
      );
      this.db
        .prepare("UPDATE schedule_deliveries SET status='sent',error=NULL WHERE occurrence_id=?")
        .run(row.occurrence_id!);
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      this.db
        .prepare('UPDATE schedule_deliveries SET status=?,error=? WHERE occurrence_id=?')
        .run(
          error instanceof DeliveryError ? error.outcome : 'unknown',
          target.kind === 'email'
            ? '邮件未确认发送，请检查 SMTP 配置及收件箱；不会自动重发'
            : target.kind === 'qq'
              ? 'QQ 未确认发送，请核对收件及机器人主动消息权限；不会自动重发'
              : target.kind === 'webhook'
                ? 'Webhook 未确认发送，请核对接收端；不会自动重发'
                : '微信未确认发送，请核对收件；可向机器人发送消息更新上下文后手动运行，旧结果不会自动重发',
          row.occurrence_id!,
        );
      this.logs?.record(String(row.user_id), {
        level: 'error',
        source: 'channel',
        event: 'channel.schedule_delivery_failed',
        message: `${target.kind === 'email' ? '邮箱' : target.kind === 'qq' ? 'QQ' : target.kind === 'webhook' ? 'Webhook' : '微信'}定时消息投递失败或结果未知`,
        entity: { type: 'occurrence', id: String(row.occurrence_id) },
        metadata: {
          channelKind: target.kind,
          status: error instanceof DeliveryError ? error.outcome : 'unknown',
        },
      });
    }
  }
  /** 发送待投递内容并记录投递结果。 */
  private async deliver(runtime: Runtime, row: Row) {
    this.db.prepare("UPDATE channel_outbox SET status='sending' WHERE id=?").run(row.id!);
    try {
      await runtime.transport.send(
        {
          id: String(row.id),
          part: Number(row.part),
          text: String(row.text),
          eventId: String(row.event_id),
          senderId: String(row.sender_id),
          replyContext: String(row.reply_context),
        },
        runtime.controller.signal,
      );
      this.db.prepare("UPDATE channel_outbox SET status='sent',error=NULL WHERE id=?").run(row.id!);
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      this.db
        .prepare('UPDATE channel_outbox SET status=?,error=? WHERE id=?')
        .run(
          error instanceof DeliveryError ? error.outcome : 'unknown',
          '平台未确认投递结果；请到原聊天核对。后续分段已暂停，不会重新执行任务。',
          row.id!,
        );
      /** 当前渠道账号。 */
      const account = this.account(
        String(
          this.db.prepare('SELECT account_id FROM channel_inbox WHERE id=?').get(row.inbox_id!)!
            .account_id,
        ),
      );
      this.logs?.record(account.userId, {
        level: 'error',
        source: 'channel',
        event: 'channel.delivery_failed',
        message: `${account.kind === 'email' ? '邮箱' : account.kind === 'qq' ? 'QQ' : account.kind === 'webhook' ? 'Webhook' : '微信'}消息投递失败或结果未知`,
        entity: { type: 'channel', id: account.id },
        metadata: {
          channelKind: account.kind,
          status: error instanceof DeliveryError ? error.outcome : 'unknown',
        },
      });
    }
  }
  /** 关闭当前资源或编辑界面。 */
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.runtimes.keys()].map((id) => this.disconnect(id)));
  }
}
