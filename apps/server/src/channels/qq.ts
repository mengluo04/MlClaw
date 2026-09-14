// 官方 QQ Bot 协议；字段与握手参考腾讯 qqbot-nodejs 1.0.4（MIT）。
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import {
  boundedString,
  ChannelError,
  DeliveryError,
  record,
  type ChannelAccount,
  type ChannelSink,
  type ChannelTransport,
  type InboundMessage,
  type OutboundMessage,
} from './types.js';
import { requestJson, type Fetcher } from './http.js';

/** 解析 QQ 私聊事件为统一入站消息。 */
export const parseQQMessage = (value: unknown): InboundMessage => {
  /** 当前消息数据。 */
  const msg = record(value);
  /** QQ 入站消息的发送者信息。 */
  const author = record(msg.author);
  /** 渠道消息发送者标识。 */
  const senderId = boundedString(author.user_openid);
  /** 事件标识，用于去重或续传。 */
  const eventId = boundedString(msg.id);
  return {
    eventId,
    senderId,
    text:
      Array.isArray(msg.attachments) && msg.attachments.length
        ? ''
        : typeof msg.content === 'string'
          ? msg.content
          : '',
    replyContext: eventId,
  };
};
/** 创建模拟 QQ 网关事件流。 */
export const qqGateway = (value: unknown): string => {
  /** 当前请求或资源地址。 */
  const url = new URL(boundedString(value, 4096));
  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === 'api.sgroup.qq.com' || url.hostname.endsWith('.sgroup.qq.com'))
  )
    throw new ChannelError('QQ 网关地址无效', 502);
  return url.toString();
};
export type SocketFactory = (url: string) => WebSocket;
export class QQTransport implements ChannelTransport {
  /** 当前认证或平台访问令牌。 */
  private token = '';
  /** 缓存访问令牌的过期时间。 */
  private expiresAt = 0;
  /** 正在获取访问令牌的共享请求，避免并发刷新。 */
  private tokenRequest?: Promise<string>;
  /** 网关握手或恢复使用的会话标识。 */
  private sessionId = '';
  /** 网关最近的消息序号，用于心跳确认。 */
  private sequence: number | null = null;
  constructor(
    private account: ChannelAccount,
    private sink: ChannelSink,
    private fetcher: Fetcher = fetch,
    private socketFactory: SocketFactory = (url) =>
      new WebSocket(url, {
        maxPayload: 1024 * 1024,
        handshakeTimeout: 15000,
        followRedirects: false,
        headers: { 'User-Agent': 'MlClaw/0.1.0' },
      }),
  ) {
    if (account.cursor) {
      try {
        /** 当前分页游标。 */
        const cursor = record(JSON.parse(account.cursor));
        this.sessionId = boundedString(cursor.sessionId);
        if (!Number.isSafeInteger(cursor.sequence)) throw new Error();
        this.sequence = Number(cursor.sequence);
      } catch {
        this.sessionId = '';
        this.sequence = null;
      }
    }
  }
  /** 获取并复用尚未过期的平台访问令牌。 */
  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.expiresAt > Date.now() + 60000) return this.token;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = (async () => {
      /** 请求返回的响应。 */
      const response = await requestJson(
        'https://bots.qq.com/app/getAppAccessToken',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: this.account.remoteId, clientSecret: this.account.secret }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        },
        this.fetcher,
      );
      this.token = boundedString(response.access_token, 4096);
      /** 访问令牌的有效秒数。 */
      const seconds = Number(response.expires_in);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400)
        throw new ChannelError('QQ 令牌有效期无效', 502);
      this.expiresAt = Date.now() + seconds * 1000;
      return this.token;
    })().finally(() => {
      this.tokenRequest = undefined;
    });
    return this.tokenRequest;
  }
  /** 执行当前操作并返回执行结果。 */
  async run(signal: AbortSignal) {
    /** 连续连接失败次数，用于计算重连退避。 */
    let failures = 0;
    while (!signal.aborted) {
      this.sink.state('connecting');
      try {
        /** 当前认证或平台访问令牌。 */
        const token = await this.accessToken(signal);
        /** 请求返回的响应。 */
        const response = await requestJson(
          'https://api.sgroup.qq.com/gateway',
          {
            headers: { Authorization: `QQBot ${token}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          },
          this.fetcher,
        );
        signal.throwIfAborted();
        await this.connection(qqGateway(response.url), token, signal);
        failures = 0;
      } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
        if (signal.aborted) return;
        if (error instanceof ChannelError && error.statusCode === 401) {
          this.token = '';
          this.expiresAt = 0;
        }
        this.sink.state('error', 'QQ 连接异常，正在重试；请检查凭据和平台权限');
      }
      if (!signal.aborted)
        await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, {
          signal,
        }).catch(() => {});
    }
  }
  /** 建立 QQ 网关 WebSocket 连接并处理鉴权、心跳、事件及断开。 */
  private connection(url: string, token: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      /** 当前 WebSocket 连接。 */
      const socket = this.socketFactory(url);
      /** 连接保活定时器。 */
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      /** 上一次网关心跳是否已获确认。 */
      let acknowledged = true;
      /** 当前读取或执行是否结束。 */
      let done = false;
      /** 是否已收到 QQ 网关的握手事件。 */
      let hello = false;
      /** 握手等待超过 20 秒时结束连接的定时器。 */
      const deadline = setTimeout(() => finish(new Error('QQ 网关握手超时')), 20000);
      /** 完成当前处理并释放等待方。 */
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        clearInterval(heartbeat);
        signal.removeEventListener('abort', stop);
        socket.terminate();
        error && !signal.aborted ? reject(error) : resolve();
      };
      /** 停止当前执行或后台资源。 */
      const stop = () => finish();
      /** 发送当前内容并处理返回结果。 */
      const send = (op: number, d: unknown) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d }));
      };
      socket.on('error', () => finish(new Error('QQ 网关连接错误')));
      socket.on('close', (code) => {
        if (done) return;
        try {
          if ([4004, 4006, 4007, 4009].includes(code)) {
            this.token = '';
            this.expiresAt = 0;
            this.sessionId = '';
            this.sequence = null;
            this.sink.cursor('');
          }
        } catch {
          finish(new Error('QQ 游标保存失败'));
          return;
        }
        finish(new Error('QQ 网关已断开'));
      });
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) {
        stop();
        return;
      }
      socket.on('message', (data) => {
        if (done || signal.aborted) return;
        try {
          /** 本次收发的数据载荷。 */
          const payload = record(JSON.parse(data.toString()));
          switch (payload.op) {
            case 10: {
              if (hello) throw new Error('重复握手');
              hello = true;
              /** 周期轮询定时器句柄。 */
              const interval = Number(record(payload.d).heartbeat_interval);
              if (!Number.isFinite(interval) || interval < 1000 || interval > 120000)
                throw new Error('心跳间隔无效');
              if (this.sessionId && this.sequence !== null)
                send(6, {
                  token: `QQBot ${token}`,
                  session_id: this.sessionId,
                  seq: this.sequence,
                });
              else send(2, { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] });
              heartbeat = setInterval(() => {
                if (!acknowledged) {
                  finish(new Error('QQ 心跳超时'));
                  return;
                }
                acknowledged = false;
                send(1, this.sequence);
              }, interval);
              break;
            }
            case 11:
              acknowledged = true;
              break;
            case 1:
              send(1, this.sequence);
              break;
            case 7:
              finish(new Error('QQ 请求重连'));
              break;
            case 9:
              this.sessionId = '';
              this.sequence = null;
              this.sink.cursor('');
              this.token = '';
              finish(new Error('QQ 会话已失效'));
              break;
            case 0: {
              if (!Number.isSafeInteger(payload.s) || Number(payload.s) < 0)
                throw new Error('QQ 事件序号无效');
              if (payload.t === 'READY') {
                this.sessionId = boundedString(record(payload.d).session_id);
                clearTimeout(deadline);
                this.sink.state('connected');
              } else if (payload.t === 'RESUMED') {
                clearTimeout(deadline);
                this.sink.state('connected');
              } else if (payload.t === 'C2C_MESSAGE_CREATE')
                this.sink.receive(parseQQMessage(payload.d));
              // receive 同步完成入站持久化后才能推进恢复游标。
              this.sequence = Number(payload.s);
              if (this.sessionId)
                this.sink.cursor(
                  JSON.stringify({ sessionId: this.sessionId, sequence: this.sequence }),
                );
              break;
            }
          }
        } catch {
          finish(new Error('QQ 事件处理失败'));
        }
      });
    });
  }
  /** 发送当前内容并处理返回结果。 */
  async send(message: OutboundMessage, signal: AbortSignal) {
    try {
      /** 当前认证或平台访问令牌。 */
      const token = await this.accessToken(signal);
      signal.throwIfAborted();
      /** 本次处理结果。 */
      const result = await requestJson(
        `https://api.sgroup.qq.com/v2/users/${encodeURIComponent(message.senderId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `QQBot ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'MlClaw/0.1.0',
          },
          body: JSON.stringify({
            content: message.text,
            msg_type: 0,
            ...(message.proactive ? {} : { msg_id: message.replyContext, msg_seq: message.part }),
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        },
        this.fetcher,
      );
      boundedString(result.id);
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      if (error instanceof ChannelError && error.statusCode === 401) {
        this.token = '';
        this.expiresAt = 0;
      }
      throw new DeliveryError('unknown', 'QQ 未确认投递结果，请在 QQ 核对');
    }
  }
}
