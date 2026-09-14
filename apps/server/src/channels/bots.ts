import type { HttpInstance, HttpRequestOptions } from '@larksuiteoapi/node-sdk';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { WSClient } from '@larksuiteoapi/node-sdk';
import type { BotChannelKind, BotConfigInput } from '@mlclaw/shared';
import { requestJson, type Fetcher } from './http.js';
import {
  boundedString,
  record,
  ChannelError,
  DeliveryError,
  type ChannelAccount,
  type ChannelSink,
  type ChannelTransport,
  type InboundMessage,
  type OutboundMessage,
} from './types.js';

export const botKinds: BotChannelKind[] = [
  'telegram',
  'slack',
  'discord',
  'dingtalk',
  'feishu',
  'wecom',
];
export function validateBotConfig(kind: BotChannelKind, input: BotConfigInput) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.appId)) throw new ChannelError('应用标识格式无效');
  for (const value of [input.secret, input.appToken])
    if (value !== undefined && (!value || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)))
      throw new ChannelError('渠道凭据格式无效');
  if (kind !== 'slack' && input.appToken !== undefined)
    throw new ChannelError('此渠道不使用 App Token');
  if (
    kind === 'telegram' &&
    input.secret !== undefined &&
    !new RegExp(`^${input.appId}:[A-Za-z0-9_-]+$`).test(input.secret)
  )
    throw new ChannelError('Telegram Bot Token 必须与机器人数字 ID 一致');
  if (kind === 'wecom' && input.secret !== undefined) {
    let url: URL;
    try {
      url = new URL(input.secret);
    } catch {
      throw new ChannelError('企业微信 Webhook 地址无效');
    }
    if (
      url.origin !== 'https://qyapi.weixin.qq.com' ||
      url.username ||
      url.password ||
      url.pathname !== '/cgi-bin/webhook/send' ||
      url.hash ||
      !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get('key') ?? '') ||
      [...url.searchParams.keys()].some((key) => key !== 'key') ||
      url.searchParams.getAll('key').length !== 1
    )
      throw new ChannelError('请填写企业微信群机器人的官方 HTTPS Webhook 地址');
  }
}

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const id = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : boundedString(v);
/** 仅将平台确认的私聊用户文本转换为入站消息。群聊、机器人和编辑事件不触发任务。 */
export function parseBotMessage(kind: BotChannelKind, value: unknown): InboundMessage | null {
  const e = record(value);
  let eventId: unknown, sender: unknown, text: unknown, context: unknown;
  if (kind === 'telegram') {
    const m = object(e.message),
      from = object(m.from),
      chat = object(m.chat);
    if (chat.type !== 'private' || from.is_bot !== false || id(chat.id) !== id(from.id))
      return null;
    eventId = e.update_id;
    sender = from.id;
    text = m.text;
    context = chat.id;
  } else if (kind === 'slack') {
    const m = object(e.event);
    if (m.type !== 'message' || m.channel_type !== 'im' || m.subtype || m.bot_id) return null;
    eventId = e.event_id;
    sender = m.user;
    text = m.text;
    context = m.channel;
  } else if (kind === 'discord') {
    const author = object(e.author);
    if (e.guild_id || author.bot || e.webhook_id || (e.type !== 0 && e.type !== 19)) return null;
    eventId = e.id;
    sender = author.id;
    text = e.content;
    context = e.channel_id;
  } else if (kind === 'dingtalk') {
    if (e.conversationType !== '1' || e.msgtype !== 'text' || !e.senderStaffId) return null;
    eventId = e.msgId;
    sender = e.senderStaffId;
    text = object(e.text).content;
    context = sender;
  } else if (kind === 'feishu') {
    const m = object(e.message),
      from = object(e.sender);
    if (m.chat_type !== 'p2p' || m.message_type !== 'text' || from.sender_type !== 'user')
      return null;
    eventId = m.message_id;
    sender = object(from.sender_id).open_id;
    context = m.chat_id;
    if (typeof m.content !== 'string' || m.content.length > 65536) return null;
    try {
      text = object(JSON.parse(m.content)).text;
    } catch {
      return null;
    }
  } else return null;
  if (typeof text !== 'string' || !text.trim() || text.length > 65536) return null;
  return { eventId: id(eventId), senderId: id(sender), text, replyContext: id(context) };
}

export const botGateway = (value: unknown, domains: string[]) => {
  const url = new URL(boundedString(value, 8192));
  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    url.port ||
    !domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  )
    throw new ChannelError('平台网关地址无效', 502);
  return url;
};

export class BotTransport implements ChannelTransport {
  private token = '';
  private expires = 0;
  private discordSession = '';
  private discordSequence: number | null = null;
  private discordResumeUrl = '';
  constructor(
    private account: ChannelAccount,
    private sink: ChannelSink,
    private fetcher: Fetcher = fetch,
    private socketFactory = (url: string) =>
      new WebSocket(url, { maxPayload: 1024 * 1024, handshakeTimeout: 15000 }),
    private feishuFactory?: (
      options: ConstructorParameters<typeof WSClient>[0],
    ) => Pick<WSClient, 'start' | 'close'>,
  ) {}

  private async api(url: string, body: object, signal: AbortSignal, token?: string) {
    return requestJson(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(40000)]),
      },
      this.fetcher,
    );
  }
  private async telegram(method: string, body: object, signal: AbortSignal) {
    const res = await this.api(
      `https://api.telegram.org/bot${this.account.secret}/${method}`,
      body,
      signal,
    );
    if (res.ok !== true)
      throw new ChannelError('Telegram 请求被拒绝，请检查令牌、权限及轮询冲突', 502);
    return res;
  }
  private async slack(method: string, body: object, signal: AbortSignal, app = false) {
    const res = await this.api(
      `https://slack.com/api/${method}`,
      body,
      signal,
      `Bearer ${app ? this.account.baseUrl : this.account.secret}`,
    );
    if (res.ok !== true)
      throw new ChannelError('Slack 请求被拒绝，请检查 Token、权限与应用安装', 502);
    return res;
  }
  private async accessToken(signal: AbortSignal) {
    if (this.token && this.expires > Date.now()) return this.token;
    const ding = this.account.kind === 'dingtalk';
    const res = await this.api(
      ding
        ? 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
        : 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      ding
        ? { appKey: this.account.remoteId, appSecret: this.account.secret }
        : { app_id: this.account.remoteId, app_secret: this.account.secret },
      signal,
    );
    if (!ding && res.code !== 0) throw new ChannelError('飞书认证失败', 401);
    this.token = boundedString(ding ? res.accessToken : res.tenant_access_token, 4096);
    this.expires =
      Date.now() +
      Math.max(0, Math.min(Number(ding ? res.expireIn : res.expire) || 0, 7200) - 60) * 1000;
    return this.token;
  }
  async run(signal: AbortSignal) {
    if (this.account.kind === 'wecom') {
      this.sink.state('connected', '已启用；实际投递状态见定时任务记录');
      await this.untilAborted(signal);
      return;
    }
    if (this.account.kind === 'feishu') return this.feishu(signal);
    let retry = 1000;
    while (!signal.aborted) {
      try {
        this.sink.state('connecting');
        if (this.account.kind === 'telegram') await this.poll(signal);
        else await this.gateway(signal);
      } catch {
        if (!signal.aborted)
          this.sink.state('error', '连接中断或配置无效，正在退避重连；请核对平台权限');
      }
      if (!signal.aborted) await delay(retry, undefined, { signal }).catch(() => {});
      retry = Math.min(retry * 2, 30000);
    }
  }
  private async untilAborted(signal: AbortSignal) {
    if (signal.aborted) return;
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  }
  private async poll(signal: AbortSignal) {
    const me = object((await this.telegram('getMe', {}, signal)).result);
    if (id(me.id) !== this.account.remoteId) throw new ChannelError('机器人 ID 与 Token 不匹配');
    // 不自动删除平台上已有 Webhook；getUpdates 冲突由管理员处理。
    let offset = Number(this.account.cursor || 0);
    this.sink.state('connected');
    while (!signal.aborted) {
      const res = await this.telegram(
        'getUpdates',
        { offset, timeout: 25, limit: 50, allowed_updates: ['message'] },
        signal,
      );
      if (!Array.isArray(res.result)) throw new ChannelError('Telegram 更新格式无效', 502);
      for (const update of res.result) {
        if (signal.aborted) return;
        const e = record(update);
        if (!Number.isSafeInteger(e.update_id) || Number(e.update_id) < 0)
          throw new ChannelError('更新序号无效', 502);
        const message = parseBotMessage('telegram', e);
        if (message) this.sink.receive(message);
        offset = Number(e.update_id) + 1;
        this.sink.cursor(String(offset));
        this.account.cursor = String(offset);
      }
    }
  }
  private async gateway(signal: AbortSignal) {
    const kind = this.account.kind;
    let url: URL;
    if (kind === 'slack') {
      const auth = await this.slack('auth.test', {}, signal);
      if (auth.team_id !== this.account.remoteId)
        throw new ChannelError('Slack 工作区 ID 与 Token 不匹配');
      url = botGateway((await this.slack('apps.connections.open', {}, signal, true)).url, [
        'slack.com',
      ]);
    } else if (kind === 'dingtalk') {
      const res = await this.api(
        'https://api.dingtalk.com/v1.0/gateway/connections/open',
        {
          clientId: this.account.remoteId,
          clientSecret: this.account.secret,
          ua: 'MlClaw/0.1',
          subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
        },
        signal,
      );
      url = botGateway(res.endpoint, ['dingtalk.com']);
      url.searchParams.set('ticket', boundedString(res.ticket, 4096));
    } else {
      const me = await requestJson(
        'https://discord.com/api/v10/users/@me',
        {
          headers: { authorization: `Bot ${this.account.secret}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        },
        this.fetcher,
      );
      if (me.id !== this.account.remoteId || me.bot !== true)
        throw new ChannelError('Discord 机器人 ID 与 Token 不匹配');
      url = this.discordResumeUrl
        ? botGateway(this.discordResumeUrl, ['discord.gg'])
        : new URL('wss://gateway.discord.gg/');
      url.searchParams.set('v', '10');
      url.searchParams.set('encoding', 'json');
    }
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const ws = this.socketFactory(url.toString());
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let sequence: number | null = this.discordSequence,
        ack = true,
        lastAlive = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastAlive > 90000) ws.terminate();
        else if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30000);
      const abort = () => ws.terminate();
      const send = (data: object) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
      };
      signal.addEventListener('abort', abort, { once: true });
      ws.on('open', () => {
        if (kind === 'dingtalk') this.sink.state('connected');
      });
      ws.on('ping', () => {
        lastAlive = Date.now();
      });
      ws.on('pong', () => {
        lastAlive = Date.now();
      });
      ws.on('message', (raw) => {
        if (signal.aborted) return;
        lastAlive = Date.now();
        try {
          const e = record(JSON.parse(raw.toString()));
          if (kind === 'slack') {
            if (e.type === 'hello') this.sink.state('connected');
            if (e.type === 'disconnect') {
              ws.close();
              return;
            }
            if (e.type === 'events_api') {
              const payload = record(e.payload);
              const message =
                payload.team_id === this.account.remoteId
                  ? parseBotMessage('slack', payload)
                  : null;
              if (message) this.sink.receive(message);
            }
            if (e.envelope_id) send({ envelope_id: boundedString(e.envelope_id) });
          } else if (kind === 'dingtalk') {
            const headers = object(e.headers);
            if (e.type === 'CALLBACK' && headers.topic === '/v1.0/im/bot/messages/get') {
              const message = parseBotMessage(
                'dingtalk',
                JSON.parse(boundedString(e.data, 131072)),
              );
              if (message) this.sink.receive(message);
              send({
                code: 200,
                headers: { messageId: headers.messageId, contentType: 'application/json' },
                message: 'OK',
                data: '{}',
              });
            } else if (
              e.type === 'SYSTEM' &&
              (headers.topic === 'ping' || headers.topic === 'disconnect')
            ) {
              send({ code: 200, headers, message: 'OK', data: e.data });
              if (headers.topic === 'disconnect') ws.close();
            }
          } else {
            if (e.op === 10) {
              const ms = Number(object(e.d).heartbeat_interval);
              if (!Number.isFinite(ms) || ms < 1000 || ms > 120000 || heartbeat)
                throw new ChannelError('心跳参数无效');
              heartbeat = setInterval(() => {
                if (!ack) {
                  ws.terminate();
                  return;
                }
                ack = false;
                send({ op: 1, d: sequence });
              }, ms);
              if (this.discordSession)
                send({
                  op: 6,
                  d: {
                    token: this.account.secret,
                    session_id: this.discordSession,
                    seq: this.discordSequence,
                  },
                });
              else
                send({
                  op: 2,
                  d: {
                    token: this.account.secret,
                    intents: 4096,
                    properties: { os: process.platform, browser: 'MlClaw', device: 'MlClaw' },
                  },
                });
            } else if (e.op === 11) ack = true;
            else if (e.op === 1) send({ op: 1, d: sequence });
            else if (e.op === 7 || e.op === 9) {
              if (e.op === 9 && e.d !== true) {
                this.discordSession = '';
                this.discordSequence = null;
                this.discordResumeUrl = '';
              }
              ws.close();
            } else if (e.op === 0 && e.t === 'READY') {
              const ready = record(e.d);
              this.discordSession = boundedString(ready.session_id);
              this.discordResumeUrl = botGateway(ready.resume_gateway_url, [
                'discord.gg',
              ]).toString();
              this.sink.state('connected');
            } else if (e.op === 0 && e.t === 'RESUMED') this.sink.state('connected');
            else if (e.op === 0 && e.t === 'MESSAGE_CREATE') {
              const message = parseBotMessage('discord', e.d);
              if (message) this.sink.receive(message);
            }
            // 数据库接纳成功后再推进恢复序号。
            if (Number.isSafeInteger(e.s)) {
              sequence = Number(e.s);
              this.discordSequence = sequence;
            }
          }
        } catch {
          ws.terminate();
        }
      });
      ws.on('error', () => {
        ws.terminate();
      });
      ws.on('close', () => {
        clearInterval(heartbeat);
        clearInterval(watchdog);
        signal.removeEventListener('abort', abort);
        if (signal.aborted) resolve();
        else reject(new ChannelError('网关连接已断开', 502));
      });
      if (signal.aborted) abort();
    });
  }
  private async feishu(signal: AbortSignal) {
    const { WSClient, EventDispatcher } = await import('@larksuiteoapi/node-sdk');
    signal.throwIfAborted();
    // 官方 SDK 处理飞书 protobuf 帧和分片；日志仅转为固定脱敏状态。
    const state = (s: 'connecting' | 'connected' | 'error') => {
      if (!signal.aborted) this.sink.state(s);
    };
    const sdkRequest = async <T = unknown, R = T, D = unknown>(
      options: HttpRequestOptions<D>,
    ): Promise<R> => {
      // 此适配器仅供 SDK 的连接发现请求使用；复用可取消、有界、禁重定向的 HTTP 实现。
      if (options.url !== 'https://open.feishu.cn/callback/ws/endpoint')
        throw new ChannelError('飞书连接发现地址无效');
      const result = await this.api(options.url, record(options.data), signal);
      if (result.code === 0) botGateway(record(result.data).URL, ['feishu.cn']);
      return result as R;
    };
    const http: HttpInstance = {
      request: sdkRequest,
      get: (url, options) => sdkRequest({ ...options, url }),
      delete: (url, options) => sdkRequest({ ...options, url }),
      head: (url, options) => sdkRequest({ ...options, url }),
      options: (url, options) => sdkRequest({ ...options, url }),
      post: (url, data, options) => sdkRequest({ ...options, url, data }),
      put: (url, data, options) => sdkRequest({ ...options, url, data }),
      patch: (url, data, options) => sdkRequest({ ...options, url, data }),
    };
    const client = (this.feishuFactory ?? ((options) => new WSClient(options)))({
      appId: this.account.remoteId,
      appSecret: this.account.secret,
      httpInstance: http,
      wsConfig: { pingTimeout: 90000 },
      handshakeTimeoutMs: 15000,
      logger: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {
          state('error');
        },
      },
      onReady: () => state('connected'),
      onReconnecting: () => state('connecting'),
      onReconnected: () => state('connected'),
      onError: () => state('error'),
    });
    const close = () => client.close({ force: true });
    signal.addEventListener('abort', close, { once: true });
    try {
      signal.throwIfAborted();
      await client.start({
        eventDispatcher: new EventDispatcher({
          logger: {
            trace() {},
            debug() {},
            info() {},
            warn() {},
            error() {
              state('error');
            },
          },
        }).register({
          'im.message.receive_v1': async (e: unknown) => {
            if (signal.aborted) return;
            const message = parseBotMessage('feishu', e);
            if (message) this.sink.receive(message);
          },
        }),
      });
      await this.untilAborted(signal);
    } finally {
      close();
      signal.removeEventListener('abort', close);
    }
  }
  async send(message: OutboundMessage, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      const kind = this.account.kind;
      if (kind === 'telegram') {
        const sent = await this.telegram(
          'sendMessage',
          {
            chat_id: message.senderId,
            text: message.text,
            link_preview_options: { is_disabled: true },
          },
          signal,
        );
        if (!Number.isSafeInteger(object(sent.result).message_id))
          throw new DeliveryError('unknown');
      } else if (kind === 'slack') {
        // 只投递到绑定用户的直接会话，禁止模型文本触发 @channel 或自动展开链接。
        const dm = await this.slack('conversations.open', { users: message.senderId }, signal);
        await this.slack(
          'chat.postMessage',
          {
            channel: boundedString(object(dm.channel).id),
            text: message.text,
            mrkdwn: false,
            parse: 'none',
            unfurl_links: false,
            unfurl_media: false,
          },
          signal,
        );
      } else if (kind === 'discord') {
        let content = message.text;
        // 使用 UTF-16 长度作为更保守的上限，避免大量 Emoji 超过平台 2000 字符限制。
        if (content.length > 2000) {
          let bounded = '';
          for (const char of content) {
            if (bounded.length + char.length > 1900) break;
            bounded += char;
          }
          content = bounded + '\n（内容已截断，完整结果请在 MlClaw 网页查看）';
        }
        const auth = `Bot ${this.account.secret}`;
        const dm = await this.api(
          'https://discord.com/api/v10/users/@me/channels',
          { recipient_id: message.senderId },
          signal,
          auth,
        );
        const sent = await this.api(
          `https://discord.com/api/v10/channels/${boundedString(dm.id)}/messages`,
          {
            content,
            allowed_mentions: { parse: [] },
            nonce: createHash('sha256')
              .update(`${message.id}:${message.part}`)
              .digest('hex')
              .slice(0, 24),
            enforce_nonce: true,
          },
          signal,
          auth,
        );
        if (typeof sent.id !== 'string' || !sent.id) throw new DeliveryError('unknown');
      } else if (kind === 'feishu') {
        const res = await this.api(
          'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
          {
            receive_id: message.senderId,
            msg_type: 'text',
            content: JSON.stringify({ text: message.text }),
            uuid: createHash('sha256')
              .update(`${message.id}:${message.part}`)
              .digest('hex')
              .slice(0, 32),
          },
          signal,
          `Bearer ${await this.accessToken(signal)}`,
        );
        if (res.code !== 0) throw new DeliveryError('failed');
      } else if (kind === 'dingtalk') {
        const token = await this.accessToken(signal);
        const res = await requestJson(
          'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
            body: JSON.stringify({
              robotCode: this.account.remoteId,
              userIds: [message.senderId],
              msgKey: 'sampleText',
              msgParam: JSON.stringify({ content: message.text }),
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          },
          this.fetcher,
        );
        if (
          (Array.isArray(res.invalidStaffIdList) && res.invalidStaffIdList.length) ||
          (Array.isArray(res.flowControlledStaffIdList) && res.flowControlledStaffIdList.length)
        )
          throw new DeliveryError('failed');
        if (!res.processQueryKey) throw new DeliveryError('unknown');
      } else if (kind === 'wecom') {
        // 企业微信 text 上限按 UTF-8 字节计算。
        let text = message.text;
        if (Buffer.byteLength(text) > 2048) {
          const chars: string[] = [];
          let bytes = 0;
          for (const char of text) {
            bytes += Buffer.byteLength(char);
            if (bytes > 1900) break;
            chars.push(char);
          }
          text = chars.join('') + '\n（内容已截断，完整结果请在 MlClaw 网页查看）';
        }
        const res = await this.api(
          this.account.secret,
          { msgtype: 'text', text: { content: text } },
          signal,
        );
        if (res.errcode !== 0) throw new DeliveryError('failed');
      }
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      // 网络失败无法证明平台未接受；不重试发送，也不回显含 Token 的 URL。
      throw new DeliveryError('unknown', '平台未确认投递，请核对收件和渠道权限；不会自动重发');
    }
  }
}
