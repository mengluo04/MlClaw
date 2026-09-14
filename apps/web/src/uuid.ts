/** 生成 UUID v4，兼容普通 HTTP 下没有 randomUUID 的浏览器。 */
export const createUuid = (): string => {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  /** 使用浏览器随机源生成 128 位数据，并设置 UUID 版本和变体。 */
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  /** 每个字节保留两位十六进制，按标准 UUID 分组。 */
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
