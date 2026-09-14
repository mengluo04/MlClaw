import { record } from './types.js';

/** 只识别上下文相关的机器码或明确的输入长度诊断，不把普通 400/413 当作超限。 */
export const isContextLengthError = (body: unknown): boolean => {
  if (!record(body)) return false;
  const error = record(body.error) ? body.error : body;
  if (
    [error.code, error.type].some(
      (value) => typeof value === 'string' && /rate_limit|quota|authentication/i.test(value),
    )
  )
    return false;
  const codes = [
    'context_length_exceeded',
    'context_window_exceeded',
    'max_context_length_exceeded',
    'prompt_too_long',
    'input_too_long',
  ];
  if (
    [error.code, error.type].some(
      (value) => typeof value === 'string' && codes.includes(value.toLowerCase()),
    )
  )
    return true;
  if (typeof error.message !== 'string') return false;
  const message = error.message;
  if (/rate limit|quota|per (?:minute|day|second)|tokens? per|每分钟|配额/i.test(message))
    return false;
  return (
    /maximum context length.{0,100}(?:exceed|request|result|however|but|your messages)/i.test(
      message,
    ) ||
    /(?:context (?:length|window)|prompt (?:length|tokens)|input tokens).{0,80}(?:exceed|too (?:long|large))/i.test(
      message,
    ) ||
    /(?:prompt|input) is too long/i.test(message) ||
    /(?:上下文|输入token|输入 token).{0,40}(?:超出|超过|超限)/.test(message)
  );
};

/** 错误响应仅作分类，限制诊断读取并始终丢弃原文，不影响正常模型响应长度。 */
export const readContextError = async (response: Response): Promise<boolean> => {
  const reader = response.body?.getReader();
  if (!reader) return false;
  let text = '';
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) return false;
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return isContextLengthError(JSON.parse(text));
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
