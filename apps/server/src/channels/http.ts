import { ChannelError, record } from './types.js';

export type Fetcher = typeof fetch;
export async function requestJson(url: string, init: RequestInit, fetcher: Fetcher = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { ...init, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ChannelError(response.status === 401 || response.status === 403 ? '平台认证失败，请重新连接' : '平台请求失败，请稍后重试', response.status === 401 || response.status === 403 ? 401 : 502);
  }
  if (!response.body) throw new ChannelError('平台响应为空', 502);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024 * 1024) throw new ChannelError('平台响应超过大小限制', 502);
      chunks.push(next.value);
    }
    // Node.js 24 的 reviver source 保留 uint64 消息 ID，避免 JSON 数字舍入后碰撞。
    try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'), (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && /^\d+$/.test(context?.source ?? '') ? context!.source : value)); }
    catch { throw new ChannelError('平台响应格式无效', 502); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
