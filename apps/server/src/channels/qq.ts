// 官方 QQ Bot 协议；字段与握手参考腾讯 qqbot-nodejs 1.0.4（MIT）。
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedString, ChannelError, DeliveryError, record, type ChannelAccount, type ChannelSink, type ChannelTransport, type InboundMessage, type OutboundMessage } from './types.js';
import { requestJson, type Fetcher } from './http.js';

export function parseQQMessage(value: unknown): InboundMessage {
  const msg = record(value); const author = record(msg.author);
  const senderId = boundedString(author.user_openid); const eventId = boundedString(msg.id);
  return { eventId, senderId, text: Array.isArray(msg.attachments) && msg.attachments.length ? '' : typeof msg.content === 'string' ? msg.content : '', replyContext: eventId };
}
export function qqGateway(value: unknown): string {
  const url = new URL(boundedString(value, 4096));
  if (url.protocol !== 'wss:' || url.username || url.password || url.port || !(url.hostname === 'api.sgroup.qq.com' || url.hostname.endsWith('.sgroup.qq.com'))) throw new ChannelError('QQ 网关地址无效', 502);
  return url.toString();
}
export type SocketFactory = (url: string) => WebSocket;
export class QQTransport implements ChannelTransport {
  private token = ''; private expiresAt = 0; private tokenRequest?: Promise<string>;
  private sessionId = ''; private sequence: number | null = null;
  constructor(private account: ChannelAccount, private sink: ChannelSink, private fetcher: Fetcher = fetch,
    private socketFactory: SocketFactory = url => new WebSocket(url, { maxPayload: 1024 * 1024, handshakeTimeout: 15000, followRedirects: false, headers: { 'User-Agent': 'MlClaw/0.1.0' } })) {
    if (account.cursor) {
      try { const cursor = record(JSON.parse(account.cursor)); this.sessionId = boundedString(cursor.sessionId); if (!Number.isSafeInteger(cursor.sequence)) throw new Error(); this.sequence = Number(cursor.sequence); }
      catch { this.sessionId = ''; this.sequence = null; }
    }
  }
  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.expiresAt > Date.now() + 60000) return this.token;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = (async () => {
      const response = await requestJson('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: this.account.remoteId, clientSecret: this.account.secret }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      }, this.fetcher);
      this.token = boundedString(response.access_token, 4096);
      const seconds = Number(response.expires_in);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw new ChannelError('QQ 令牌有效期无效', 502);
      this.expiresAt = Date.now() + seconds * 1000; return this.token;
    })().finally(() => { this.tokenRequest = undefined; });
    return this.tokenRequest;
  }
  async run(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted) {
      this.sink.state('connecting');
      try {
        const token = await this.accessToken(signal);
        const response = await requestJson('https://api.sgroup.qq.com/gateway', {
          headers: { Authorization: `QQBot ${token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        }, this.fetcher);
        signal.throwIfAborted();
        await this.connection(qqGateway(response.url), token, signal); failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ChannelError && error.statusCode === 401) { this.token = ''; this.expiresAt = 0; }
        this.sink.state('error', 'QQ 连接异常，正在重试；请检查凭据和平台权限');
      }
      if (!signal.aborted) await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal }).catch(() => {});
    }
  }
  private connection(url: string, token: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(url); let heartbeat: ReturnType<typeof setInterval> | undefined;
      let acknowledged = true; let done = false; let hello = false;
      const deadline = setTimeout(() => finish(new Error('QQ 网关握手超时')), 20000);
      const finish = (error?: Error) => {
        if (done) return; done = true; clearTimeout(deadline); clearInterval(heartbeat); signal.removeEventListener('abort', stop);
        socket.terminate(); error && !signal.aborted ? reject(error) : resolve();
      };
      const stop = () => finish();
      const send = (op: number, d: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d })); };
      socket.on('error', () => finish(new Error('QQ 网关连接错误')));
      socket.on('close', code => {
        if (done) return;
        try { if ([4004, 4006, 4007, 4009].includes(code)) { this.token = ''; this.expiresAt = 0; this.sessionId = ''; this.sequence = null; this.sink.cursor(''); } }
        catch { finish(new Error('QQ 游标保存失败')); return; }
        finish(new Error('QQ 网关已断开'));
      });
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) { stop(); return; }
      socket.on('message', data => {
        if (done || signal.aborted) return;
        try {
          const payload = record(JSON.parse(data.toString()));
          switch (payload.op) {
            case 10: {
              if (hello) throw new Error('重复握手'); hello = true;
              const interval = Number(record(payload.d).heartbeat_interval);
              if (!Number.isFinite(interval) || interval < 1000 || interval > 120000) throw new Error('心跳间隔无效');
              if (this.sessionId && this.sequence !== null) send(6, { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.sequence });
              else send(2, { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] });
              heartbeat = setInterval(() => { if (!acknowledged) { finish(new Error('QQ 心跳超时')); return; } acknowledged = false; send(1, this.sequence); }, interval);
              break;
            }
            case 11: acknowledged = true; break;
            case 1: send(1, this.sequence); break;
            case 7: finish(new Error('QQ 请求重连')); break;
            case 9: this.sessionId = ''; this.sequence = null; this.sink.cursor(''); this.token = ''; finish(new Error('QQ 会话已失效')); break;
            case 0: {
              if (!Number.isSafeInteger(payload.s) || Number(payload.s) < 0) throw new Error('QQ 事件序号无效');
              if (payload.t === 'READY') { this.sessionId = boundedString(record(payload.d).session_id); clearTimeout(deadline); this.sink.state('connected'); }
              else if (payload.t === 'RESUMED') { clearTimeout(deadline); this.sink.state('connected'); }
              else if (payload.t === 'C2C_MESSAGE_CREATE') this.sink.receive(parseQQMessage(payload.d));
              // receive 同步完成入站持久化后才能推进恢复游标。
              this.sequence = Number(payload.s);
              if (this.sessionId) this.sink.cursor(JSON.stringify({ sessionId: this.sessionId, sequence: this.sequence }));
              break;
            }
          }
        } catch { finish(new Error('QQ 事件处理失败')); }
      });
    });
  }
  async send(message: OutboundMessage, signal: AbortSignal) {
    try {
      const token = await this.accessToken(signal); signal.throwIfAborted();
      const result = await requestJson(`https://api.sgroup.qq.com/v2/users/${encodeURIComponent(message.senderId)}/messages`, {
        method: 'POST', headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'MlClaw/0.1.0' },
        body: JSON.stringify({ content: message.text, msg_type: 0, ...(message.proactive ? {} : { msg_id: message.replyContext, msg_seq: message.part }) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      }, this.fetcher);
      boundedString(result.id);
    } catch (error) {
      if (error instanceof ChannelError && error.statusCode === 401) { this.token = ''; this.expiresAt = 0; }
      throw new DeliveryError('unknown', 'QQ 未确认投递结果，请在 QQ 核对');
    }
  }
}
