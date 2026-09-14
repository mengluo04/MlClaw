import type { Fetcher } from './http.js';
import type { WebhookConfigInput, WebhookRequestConfig } from '@mlclaw/shared';
import {
  ChannelError,
  DeliveryError,
  type ChannelAccount,
  type ChannelSink,
  type ChannelTransport,
  type OutboundMessage,
} from './types.js';

/** 兼容旧配置的默认请求。 */
export const defaultWebhookConfig = (token = ''): WebhookRequestConfig => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  bodyTemplate: '{"id":"{{id}}","type":"schedule.result","text":"{{text}}"}',
});

/** 仅替换白名单变量，不执行表达式，也不递归展开任务内容。 */
const substitute = (value: string, id: string, text: string): string =>
  value.replace(/\{\{(id|text)\}\}/g, (_, key: string) => (key === 'id' ? id : text));

/** JSON 先解析再替换字符串值，确保任务中的引号、换行不会破坏结构。 */
export const renderWebhookBody = (
  config: WebhookRequestConfig,
  id: string,
  text: string,
): string => {
  if (!config.bodyTemplate) return '';
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(config.headers['content-type'] ?? ''))
    return substitute(config.bodyTemplate, id, text);
  /** 逐项替换 JSON 字符串值，属性名称保持不变。 */
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') return substitute(value, id, text);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  try {
    return JSON.stringify(replace(JSON.parse(config.bodyTemplate)));
  } catch {
    throw new ChannelError('Content-Type 为 JSON 时，请求体必须是有效 JSON；变量请写在字符串值内');
  }
};

/** 校验请求配置；null 仅保留同一地址下同名 Header 的已保存值。 */
export const resolveWebhookConfig = (
  input: WebhookConfigInput,
  previous = defaultWebhookConfig(),
  changedUrl = false,
): WebhookRequestConfig => {
  const method = input.method ?? previous.method;
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
    throw new ChannelError('不支持的 Webhook 请求方式');
  const source = input.headers ?? (changedUrl ? defaultWebhookConfig().headers : previous.headers);
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    Object.keys(source).length > 32
  )
    throw new ChannelError('Headers 必须是最多 32 项的键值对');
  const entries: Array<[string, string]> = [];
  const names = new Set<string>();
  for (const [name, value] of Object.entries(source)) {
    const key = name.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) ||
      key.length > 128 ||
      names.has(key) ||
      [
        'host',
        'content-length',
        'connection',
        'transfer-encoding',
        'upgrade',
        'expect',
        'trailer',
        'te',
        'idempotency-key',
      ].includes(key) ||
      key.startsWith('proxy-') ||
      key.startsWith('sec-')
    )
      throw new ChannelError('Header 名称无效、重复或属于系统管理字段');
    names.add(key);
    const resolved = value === null && !changedUrl ? previous.headers[key] : value;
    if (
      typeof resolved !== 'string' ||
      resolved.length > 8192 ||
      /[^\t\x20-\x7e\x80-\xff]/.test(resolved)
    )
      throw new ChannelError('Header 值无效；更换地址或新增 Header 时需填写值');
    entries.push([key, resolved.trim()]);
  }
  if (JSON.stringify(entries).length > 16384)
    throw new ChannelError('Headers 总长度不能超过 16 KB');
  const bodyTemplate = input.bodyTemplate ?? previous.bodyTemplate;
  if (typeof bodyTemplate !== 'string' || bodyTemplate.length > 32768)
    throw new ChannelError('请求体模板不能超过 32768 字符');
  const config = { method, headers: Object.fromEntries(entries), bodyTemplate };
  if (method !== 'GET') renderWebhookBody(config, 'validation', 'validation');
  return config;
};

/** 校验 Webhook 地址协议及结构。 */
export const validateWebhookUrl = (value: string): string => {
  try {
    /** 当前请求或资源地址。 */
    const url = new URL(value);
    if (
      value.length > 4096 ||
      /[\s\u0000-\u001f]/.test(value) ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
    return url.href;
  } catch {
    throw new ChannelError('请填写有效的 HTTP 或 HTTPS Webhook 地址，不含用户名、密码或片段');
  }
};

// 地址只由已登录管理员配置；允许自托管内网接收端，不接受模型或任务提供的地址。
export class WebhookTransport implements ChannelTransport {
  constructor(
    private account: ChannelAccount,
    private sink: ChannelSink,
    private fetcher: Fetcher = fetch,
  ) {}
  /** 执行当前操作并返回执行结果。 */
  async run(signal: AbortSignal) {
    if (signal.aborted) return;
    this.sink.state('connected', '已启用，实际送达状态请查看定时任务执行历史');
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  }
  /** 发送当前内容并处理返回结果。 */
  async send(message: OutboundMessage, signal: AbortSignal) {
    if (signal.aborted) throw new DeliveryError('failed');
    /** 当前请求或资源地址。 */
    const url = validateWebhookUrl(this.account.baseUrl);
    const config = this.account.webhook ?? defaultWebhookConfig(this.account.secret);
    /** 发送前检查渲染体积，避免重复变量放大输出；尚未发出请求可确定失败。 */
    let body: string | undefined;
    try {
      body =
        config.method === 'GET' || !config.bodyTemplate
          ? undefined
          : renderWebhookBody(config, message.id, message.text);
      if (body && Buffer.byteLength(body) > 256 * 1024) throw new Error();
    } catch {
      throw new DeliveryError('failed', 'Webhook 请求体无效或超过 256 KB');
    }
    try {
      /** 请求返回的响应。 */
      const response = await this.fetcher(url, {
        method: config.method,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: {
          ...config.headers,
          'idempotency-key': message.id,
        },
        ...(body === undefined ? {} : { body }),
      });
      await response.body?.cancel();
      if (!response.ok) throw new DeliveryError('failed');
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      if (error instanceof DeliveryError) throw error;
      // 网络中断或超时后不能判断接收端是否已处理；不泄露 URL、令牌及响应内容。
      throw new DeliveryError('unknown');
    }
  }
}
