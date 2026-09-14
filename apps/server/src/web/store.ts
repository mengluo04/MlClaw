import type { DatabaseSync } from 'node:sqlite';
import type { WebSettings, WebSettingsInput } from '@mlclaw/shared';
import { transaction } from '../db/index.js';
import { formatSystemTime } from '../time.js';
import { WebError } from './types.js';
import { providerNeedsApiKey, providerSupportsFetch } from './types.js';

export interface WebConfig extends WebSettings {
  apiKey: string;
}

/** 校验并规范化 SearXNG 服务地址。 */
const searxngBaseUrl = (input: string) => {
  if (!input) return '';
  /** 当前请求或资源地址。 */
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebError('请输入有效的 SearXNG 实例地址');
  }
  if (
    input.length > 2048 ||
    /[\x00-\x20\x7f\\]/.test(input) ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new WebError('SearXNG 地址仅支持不含凭据、查询参数或片段的 HTTP(S) URL');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/search$/, '') || '/';
  return url.href.replace(/\/$/, '');
};

/** 判断联网服务必需配置是否齐全。 */
export const webConfigReady = (config: Pick<WebConfig, 'provider' | 'apiKey' | 'baseUrl'>) => {
  return providerNeedsApiKey(config.provider) ? !!config.apiKey : !!config.baseUrl;
};
/** 读取服务端联网配置，包括调用所需凭据。 */
export const getWebConfig = (db: DatabaseSync, userId: string): WebConfig => {
  /** web_settings 表的查询记录。 */
  const row = db.prepare('SELECT * FROM web_settings WHERE user_id=?').get(userId);
  if (!row)
    return {
      provider: 'tavily',
      enabled: false,
      allowFetch: true,
      allowSchedules: false,
      baseUrl: '',
      apiKey: '',
      hasApiKey: false,
      supportsFetch: true,
      version: 0,
      updatedAt: null,
    };
  return {
    provider: String(row.provider) as WebConfig['provider'],
    enabled: !!row.enabled,
    allowFetch: !!row.allow_fetch,
    allowSchedules: !!row.allow_schedules,
    baseUrl: String(row.base_url),
    apiKey: String(row.api_key),
    hasApiKey: !!row.api_key,
    supportsFetch: providerSupportsFetch(String(row.provider) as WebConfig['provider']),
    version: Number(row.version),
    updatedAt: String(row.updated_at),
  };
};
/** 去除服务端密钥后生成公开联网配置。 */
export const publicWebConfig = (config: WebConfig): WebSettings => {
  /** 解构时剔除不应对外返回的内部字段。 */
  const { apiKey: _, ...result } = config;
  return result;
};
/** 校验并保存联网服务配置。 */
export const saveWebConfig = (
  db: DatabaseSync,
  userId: string,
  input: WebSettingsInput,
): WebSettings => {
  return transaction(db, () => {
    /** 修改前的数据。 */
    const previous = getWebConfig(db, userId);
    if (input.expectedVersion !== previous.version)
      throw new WebError('联网配置已被其他页面更新，请重新加载后再保存；当前草稿已保留', 409);
    /** 提供商是否已经切换。 */
    const providerChanged = input.provider !== previous.provider;
    /** 当前索引或字段键。 */
    let key =
      input.apiKey === undefined ? (providerChanged ? '' : previous.apiKey) : input.apiKey.trim();
    if (key && /[^\x21-\x7e]/.test(key)) throw new WebError('API Key 只能包含非空白的 ASCII 字符');
    if (!providerNeedsApiKey(input.provider)) key = '';
    /** 服务基础地址。 */
    const baseUrl =
      input.provider === 'searxng'
        ? searxngBaseUrl(
            input.baseUrl === undefined
              ? providerChanged
                ? ''
                : previous.baseUrl
              : input.baseUrl.trim(),
          )
        : '';
    /** 当前运行前提是否已经满足。 */
    const ready = providerNeedsApiKey(input.provider) ? !!key : !!baseUrl;
    // 清除当前服务凭据同时关闭联网，避免留下看似启用但无法工作的配置。
    const enabled =
      input.apiKey === '' && providerNeedsApiKey(input.provider) ? false : input.enabled;
    if (enabled && !ready)
      throw new WebError(
        input.provider === 'searxng'
          ? '启用联网搜索前请填写 SearXNG 实例地址'
          : '启用联网搜索前请填写 API Key',
      );
    /** 是否允许读取网页正文。 */
    const allowFetch = providerSupportsFetch(input.provider) && input.allowFetch;
    db.prepare(
      `INSERT INTO web_settings VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
      provider=excluded.provider,enabled=excluded.enabled,allow_fetch=excluded.allow_fetch,allow_schedules=excluded.allow_schedules,
      api_key=excluded.api_key,base_url=excluded.base_url,version=excluded.version,updated_at=excluded.updated_at`,
    ).run(
      userId,
      input.provider,
      Number(enabled),
      Number(allowFetch),
      Number(input.allowSchedules),
      key,
      baseUrl,
      previous.version + 1,
      formatSystemTime(),
    );
    return publicWebConfig(getWebConfig(db, userId));
  });
};
