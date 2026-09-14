import { ChannelError, record } from './types.js';

export type Fetcher = typeof fetch;
/** 在取消及大小限制下请求并解析 JSON。 */
export const requestJson = async (
  url: string,
  init: RequestInit,
  fetcher: Fetcher = fetch,
): Promise<Record<string, unknown>> => {
  /** 请求返回的响应。 */
  const response = await fetcher(url, { ...init, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ChannelError(
      response.status === 401 || response.status === 403
        ? '平台认证失败，请重新连接'
        : '平台请求失败，请稍后重试',
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  if (!response.body) throw new ChannelError('平台响应为空', 502);
  /** 流数据读取器。 */
  const reader = response.body.getReader();
  /** 已收集的数据分块。 */
  const chunks: Uint8Array[] = [];
  /** 当前数据大小。 */
  let size = 0;
  try {
    while (true) {
      /** 下一次处理使用的数据。 */
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024 * 1024) throw new ChannelError('平台响应超过大小限制', 502);
      chunks.push(next.value);
    }
    // Node.js 24 的 reviver source 保留 uint64 消息 ID，避免 JSON 数字舍入后碰撞。
    try {
      return record(
        JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
          (_key, value: unknown, context?: { source?: string }) =>
            typeof value === 'number' &&
            Number.isInteger(value) &&
            !Number.isSafeInteger(value) &&
            /^\d+$/.test(context?.source ?? '')
              ? context!.source
              : value,
        ),
      );
    } catch {
      throw new ChannelError('平台响应格式无效', 502);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
