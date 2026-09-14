// iLink 文本协议参考腾讯 openclaw-weixin 2.4.8（MIT），见 docs/THIRD_PARTY_NOTICES.md。
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { requestJson, type Fetcher } from './http.js';
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

/** 微信接口的默认基础地址。 */
export const WEIXIN_BASE = 'https://ilinkai.weixin.qq.com';
/** 校验微信服务基础地址。 */
export const weixinBase = (value: string): string => {
  /** 当前请求或资源地址。 */
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname) ||
    !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com'))
  )
    throw new ChannelError('微信返回了不受信任的服务地址', 502);
  return url.origin;
};
export class WeixinApi {
  constructor(private fetcher: Fetcher = fetch) {}
  /** 构造 iLink 协议请求头并调用微信接口。 */
  async call(base: string, endpoint: string, signal: AbortSignal, body?: unknown, token?: string) {
    /** 当前 HTTP 请求头。 */
    const headers: Record<string, string> = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '132104',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString(
        'base64',
      );
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    /** 本次处理结果。 */
    const result = await requestJson(
      `${weixinBase(base)}/${endpoint}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.fetcher,
    );
    if (result.errcode === -14 || result.ret === -14)
      throw new ChannelError('微信登录已失效，请重新扫码', 401);
    if (
      (result.ret !== undefined && result.ret !== 0) ||
      (result.errcode !== undefined && result.errcode !== 0)
    )
      throw new ChannelError('微信接口拒绝请求', 502);
    return result;
  }
  /** 生成或读取扫码登录二维码。 */
  qr(signal: AbortSignal) {
    return this.call(WEIXIN_BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', signal, {
      local_token_list: [],
    });
  }
  /** 读取当前记录的状态。 */
  status(base: string, code: string, signal: AbortSignal, verifyCode?: string) {
    return this.call(
      base,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(code)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`,
      signal,
    );
  }
}
/** 微信 iLink 请求携带的客户端版本信息。 */
const baseInfo = { channel_version: '2.4.8', bot_agent: 'MlClaw/0.1.0' };

/** 解析微信消息为统一入站结构。 */
export const parseWeixinMessage = (value: unknown): InboundMessage | null => {
  /** 当前消息数据。 */
  const msg = record(value);
  if (
    msg.message_type !== 1 ||
    (msg.group_id !== undefined && msg.group_id !== '') ||
    (msg.message_state !== undefined && msg.message_state !== 2)
  )
    return null;
  /** 渠道消息发送者标识。 */
  const senderId = boundedString(msg.from_user_id);
  // 不接受 JSON 数字精度已丢失的消息 ID，避免不同消息错误去重。
  const eventId =
    typeof msg.message_id === 'string'
      ? boundedString(msg.message_id)
      : Number.isSafeInteger(msg.message_id)
        ? String(msg.message_id)
        : boundedString(msg.client_id);
  if (!Array.isArray(msg.item_list) || msg.item_list.length > 100)
    throw new ChannelError('微信消息内容无效', 502);
  /** 拆分后的内容片段。 */
  const parts = msg.item_list.map(record);
  if (parts.some((item) => item.type !== 1))
    return { eventId, senderId, text: '', replyContext: boundedString(msg.context_token, 16384) };
  /** 当前处理的文本。 */
  const text = parts.map((item) => boundedString(record(item.text_item).text, 8000)).join('\n');
  return { eventId, senderId, text, replyContext: boundedString(msg.context_token, 16384) };
};

export class WeixinTransport implements ChannelTransport {
  constructor(
    private account: ChannelAccount,
    private sink: ChannelSink,
    private api = new WeixinApi(),
  ) {}
  /** 执行当前操作并返回执行结果。 */
  async run(signal: AbortSignal) {
    /** 当前分页游标。 */
    let cursor = this.account.cursor;
    /** 累计失败集合数量，用于本次流程的统计或上限检查。 */
    let failures = 0;
    while (!signal.aborted) {
      try {
        /** 本次处理结果。 */
        const result = await this.api.call(
          this.account.baseUrl,
          'ilink/bot/getupdates',
          AbortSignal.any([signal, AbortSignal.timeout(40000)]),
          { get_updates_buf: cursor, base_info: baseInfo },
          this.account.secret,
        );
        signal.throwIfAborted();
        if (result.msgs !== undefined && (!Array.isArray(result.msgs) || result.msgs.length > 1000))
          throw new ChannelError('微信消息列表无效', 502);
        /** 当前会话的消息列表。 */
        const messages = (Array.isArray(result.msgs) ? result.msgs : []).map(parseWeixinMessage);
        for (/* 逐项处理当前消息数据。 */ const msg of messages) if (msg) this.sink.receive(msg);
        if (result.get_updates_buf !== undefined) {
          cursor =
            result.get_updates_buf === '' ? '' : boundedString(result.get_updates_buf, 262144);
          this.sink.cursor(cursor);
        }
        failures = 0;
        this.sink.state('connected');
        await delay(250, undefined, { signal });
      } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
        if (signal.aborted) return;
        if (error instanceof ChannelError && error.statusCode === 401) {
          this.sink.state('expired', '微信登录已失效，请重新扫码');
          return;
        }
        if (error instanceof Error && error.name === 'TimeoutError') continue;
        this.sink.state('error', '微信连接异常，正在重试');
        await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, {
          signal,
        }).catch(() => {});
      }
    }
  }
  /** 发送当前内容并处理返回结果。 */
  async send(message: OutboundMessage, signal: AbortSignal) {
    try {
      await this.api.call(
        this.account.baseUrl,
        'ilink/bot/sendmessage',
        AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        {
          base_info: baseInfo,
          msg: {
            from_user_id: '',
            to_user_id: message.senderId,
            client_id: `mlclaw-${message.id}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: message.text } }],
            context_token: message.replyContext,
          },
        },
        this.account.secret,
      );
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      throw new DeliveryError(
        error instanceof ChannelError && error.statusCode === 401 ? 'failed' : 'unknown',
        error instanceof ChannelError && error.statusCode === 401
          ? '微信登录已失效'
          : '微信未确认投递结果，请在微信核对',
      );
    }
  }
}
