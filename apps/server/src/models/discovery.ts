import type { DiscoveredModels } from '@mlclaw/shared';
import { record } from '../providers/types.js';
import { ModelSettingsError } from './store.js';

// 只返回受限的模型标识及显示名称，不透传上游响应、链接或错误正文。
export const discoverModels = async (
  config: { baseUrl: string; apiKey: string },
  signal: AbortSignal,
  request: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<DiscoveredModels> => {
  /** 合并主动取消与超时限制的信号。 */
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    /** 请求返回的响应。 */
    const response = await request(`${config.baseUrl}/models`, {
      redirect: 'error',
      signal: combined,
      headers: {
        Accept: 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      /** 当前消息或提示内容。 */
      const message =
        response.status === 401 || response.status === 403
          ? '模型列表鉴权失败，请检查密钥及所属地域'
          : response.status === 404 || response.status === 405
            ? '此地址不提供兼容的模型列表接口，请检查基础地址或手动填写模型 ID'
            : response.status === 429
              ? '获取模型列表过于频繁，请稍后重试'
              : `获取模型列表失败（HTTP ${response.status}）`;
      throw new ModelSettingsError(message, 502);
    }
    /** 流数据读取器。 */
    const reader = response.body?.getReader();
    if (!reader) throw new ModelSettingsError('模型列表响应为空', 502);
    /** 已收集的数据分块。 */
    const chunks: Uint8Array[] = [];
    /** 当前数据大小。 */
    let size = 0;
    try {
      while (true) {
        combined.throwIfAborted();
        /** 当前处理的内容片段。 */
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024)
          throw new ModelSettingsError('模型列表响应超过 1 MiB 上限，请手动填写模型 ID', 502);
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    /** 从 JSON 文本解析的结构化数据，后续仍需按业务规则校验。 */
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!record(body) || body.error || !Array.isArray(body.data))
      throw new ModelSettingsError('上游未返回兼容的模型列表，请手动填写模型 ID', 502);
    /** 当前可用模型列表。 */
    const models = new Map<string, { id: string; name: string }>();
    /** 返回内容是否因上限被截断。 */
    let truncated = body.has_more === true || Boolean(body.next_page_token);
    for (/* 逐项处理当前处理的条目。 */ const item of body.data) {
      if (
        !record(item) ||
        typeof item.id !== 'string' ||
        !item.id.trim() ||
        item.id.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(item.id)
      )
        throw new ModelSettingsError('上游模型列表包含无效的模型 ID', 502);
      /** 当前记录标识。 */
      const id = item.id.trim();
      if (models.has(id)) continue;
      if (models.size >= 1000) {
        truncated = true;
        continue;
      }
      /** 当前对象名称。 */
      const name =
        typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 200) : id;
      models.set(id, { id, name });
    }
    return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), truncated };
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
    if (signal.aborted) throw new ModelSettingsError('模型列表请求已取消', 408);
    if (combined.aborted)
      throw new ModelSettingsError('获取模型列表超时，请重试或手动填写模型 ID', 504);
    if (error instanceof ModelSettingsError) throw error;
    throw new ModelSettingsError('获取模型列表失败，请检查地址、网络和响应格式后重试', 502);
  }
};
