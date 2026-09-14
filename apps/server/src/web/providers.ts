import type { WebProviderName } from '@mlclaw/shared';
import { record } from '../providers/types.js';
import { formatSystemTime } from '../time.js';
import { publicUrl, TavilyProvider } from './tavily.js';
import { WebError, type PageResponse, type SearchResponse, type WebProvider } from './types.js';

type ProviderConfig = {
  provider: WebProviderName;
  apiKey: string;
  baseUrl: string;
};

/** 清理返回文本并限制可见内容。 */
const clean = (value: string, secret: string, limit: number) => {
  /** 移除敏感值后的返回文本。 */
  const redacted = secret ? value.split(secret).join('[已脱敏]') : value;
  return redacted.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, limit);
};

/** 清理搜索结果地址并屏蔽敏感值。 */
const resultUrl = (value: unknown, secret: string) => {
  if (typeof value !== 'string' || (secret && value.includes(secret)))
    throw new WebError('联网服务返回了无效来源 URL', 502);
  return publicUrl(value);
};

/** 在取消及大小限制下请求并解析 JSON。 */
const requestJson = async (
  service: string,
  request: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
) => {
  signal.throwIfAborted();
  /** 请求返回的响应。 */
  let response: Response;
  try {
    response = await request(url, { ...init, redirect: 'error', signal });
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
    signal.throwIfAborted();
    if (error instanceof WebError) throw error;
    throw new WebError(`${service} 连接失败，请检查网络和服务地址后重试`, 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new WebError(`${service} 认证或访问失败，请检查配置`, 502);
    if (response.status === 402 || response.status === 429)
      throw new WebError(`${service} 请求受限或额度不足，请稍后重试并检查额度`, 502);
    throw new WebError(`${service} 服务请求失败（HTTP ${response.status}）`, 502);
  }
  /** 流数据读取器。 */
  const reader = response.body?.getReader();
  if (!reader) throw new WebError(`${service} 返回了空响应`, 502);
  /** 已收集的数据分块。 */
  const chunks: Uint8Array[] = [];
  /** 当前数据大小。 */
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      /** 当前处理的内容片段。 */
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024 * 1024) throw new WebError(`${service} 响应超过 1 MiB 限制`, 502);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    /** 从 JSON 文本解析的结构化数据，后续仍需按业务规则校验。 */
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!record(value)) throw new Error();
    return value;
  } catch {
    throw new WebError(`${service} 返回了无效 JSON`, 502);
  }
};

/** 统一各搜索服务的结果结构并限制返回数量。 */
const searchResponse = (
  source: WebProviderName,
  rows: unknown[],
  maxResults: number,
  secret: string,
  fields: (row: Record<string, unknown>) => {
    title: unknown;
    url: unknown;
    snippet: unknown;
    publishedAt?: unknown;
  },
): SearchResponse => {
  /** 本次处理结果列表。 */
  const results: SearchResponse['results'] = [];
  for (/* 逐项处理当前处理的值。 */ const value of rows.slice(0, maxResults)) {
    if (!record(value)) throw new WebError(`${source} 搜索结果字段无效`, 502);
    /** 当前数据库记录。 */
    const row = fields(value);
    if (typeof row.title !== 'string' || typeof row.snippet !== 'string')
      throw new WebError(`${source} 搜索结果字段无效`, 502);
    /** 当前请求或资源地址。 */
    let url: string;
    try {
      url = resultUrl(row.url, secret);
    } catch {
      continue;
    }
    results.push({
      title: clean(row.title, secret, 200),
      url,
      snippet: clean(row.snippet, secret, 700),
      publishedAt: typeof row.publishedAt === 'string' ? clean(row.publishedAt, secret, 80) : null,
      truncated: row.title.length > 200 || row.snippet.length > 700,
    });
  }
  while (JSON.stringify(results).length > 14000) results.pop();
  return {
    results,
    fetchedAt: formatSystemTime(),
    source,
    referenceOnly: true,
    truncated: rows.length > results.length || results.some((item) => item.truncated),
  };
};

/** 整理网页正文与来源信息，并限制输出大小。 */
const pageResponse = (
  source: WebProviderName,
  inputUrl: string,
  secret: string,
  row: Record<string, unknown>,
  content: unknown,
): PageResponse => {
  if (typeof content !== 'string' || !content.trim())
    throw new WebError('网页正文无法读取，页面可能需要登录或不支持提取', 502);
  /** 上游返回并经过校验的来源地址。 */
  const reportedUrl =
    row.url ?? (record(row.metadata) ? (row.metadata.sourceURL ?? row.metadata.url) : undefined);
  return {
    title:
      typeof row.title === 'string'
        ? clean(row.title, secret, 200)
        : record(row.metadata) && typeof row.metadata.title === 'string'
          ? clean(row.metadata.title, secret, 200)
          : null,
    url: reportedUrl === undefined ? inputUrl : resultUrl(reportedUrl, secret),
    content: clean(content, secret, Infinity),
    fetchedAt: formatSystemTime(),
    truncated: row.truncated === true,
    source,
    referenceOnly: true,
  };
};

abstract class ApiProvider implements WebProvider {
  /** 所选联网服务是否支持正文读取。 */
  abstract readonly supportsFetch: boolean;
  constructor(
    protected apiKey: string,
    protected request: typeof fetch = fetch,
  ) {}
  abstract search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResponse>;
  extract?(url: string, signal: AbortSignal): Promise<PageResponse>;
}

export class BraveProvider extends ApiProvider {
  /** 所选联网服务是否支持正文读取。 */
  readonly supportsFetch = false;
  /** 按当前关键词执行检索。 */
  async search(query: string, maxResults: number, signal: AbortSignal) {
    /** 当前请求或资源地址。 */
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));
    url.searchParams.set('safesearch', 'moderate');
    /** 当前处理的数据。 */
    const data = await requestJson(
      'Brave',
      this.request,
      url.href,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey } },
      signal,
    );
    /** 查询返回的记录列表。 */
    const rows = record(data.web) && Array.isArray(data.web.results) ? data.web.results : [];
    return searchResponse('brave', rows, maxResults, this.apiKey, (row) => ({
      title: row.title,
      url: row.url,
      snippet: row.description,
      publishedAt: row.page_age,
    }));
  }
}

export class ExaProvider extends ApiProvider {
  /** 所选联网服务是否支持正文读取。 */
  readonly supportsFetch = true;
  /** 发送 POST 请求。 */
  private post(path: 'search' | 'contents', body: object, signal: AbortSignal) {
    return requestJson(
      'Exa',
      this.request,
      `https://api.exa.ai/${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify(body),
      },
      signal,
    );
  }
  /** 按当前关键词执行检索。 */
  async search(query: string, maxResults: number, signal: AbortSignal) {
    /** 当前处理的数据。 */
    const data = await this.post(
      'search',
      { query, numResults: maxResults, type: 'auto', contents: { highlights: true } },
      signal,
    );
    if (!Array.isArray(data.results)) throw new WebError('Exa 返回了无效结果结构', 502);
    return searchResponse('exa', data.results, maxResults, this.apiKey, (row) => ({
      title: row.title,
      url: row.url,
      snippet: Array.isArray(row.highlights)
        ? row.highlights.filter((item): item is string => typeof item === 'string').join('\n')
        : typeof row.summary === 'string'
          ? row.summary
          : typeof row.text === 'string'
            ? row.text
            : '',
      publishedAt: row.publishedDate,
    }));
  }
  /** 提取响应中可用的内容。 */
  async extract(input: string, signal: AbortSignal) {
    /** 当前请求或资源地址。 */
    const url = publicUrl(input);
    /** 当前处理的数据。 */
    const data = await this.post('contents', { urls: [url], text: true }, signal);
    if (!Array.isArray(data.results) || !record(data.results[0]))
      throw new WebError('网页正文无法读取，页面可能需要登录或不支持提取', 502);
    /** 当前数据库记录。 */
    const row = data.results[0];
    return pageResponse('exa', url, this.apiKey, row, row.text);
  }
}

export class FirecrawlProvider extends ApiProvider {
  /** 所选联网服务是否支持正文读取。 */
  readonly supportsFetch = true;
  /** 发送 POST 请求。 */
  private post(path: 'search' | 'scrape', body: object, signal: AbortSignal) {
    return requestJson(
      'Firecrawl',
      this.request,
      `https://api.firecrawl.dev/v2/${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      },
      signal,
    );
  }
  /** 按当前关键词执行检索。 */
  async search(query: string, maxResults: number, signal: AbortSignal) {
    /** 当前处理的数据。 */
    const data = await this.post(
      'search',
      { query, limit: maxResults, sources: ['web'], ignoreInvalidURLs: true },
      signal,
    );
    if (!record(data.data) || !Array.isArray(data.data.web))
      throw new WebError('Firecrawl 返回了无效结果结构', 502);
    return searchResponse('firecrawl', data.data.web, maxResults, this.apiKey, (row) => ({
      title: row.title,
      url: row.url,
      snippet: row.description,
    }));
  }
  /** 提取响应中可用的内容。 */
  async extract(input: string, signal: AbortSignal) {
    /** 当前请求或资源地址。 */
    const url = publicUrl(input);
    /** 当前处理的数据。 */
    const data = await this.post(
      'scrape',
      { url, formats: ['markdown'], onlyMainContent: true, timeout: 7000 },
      signal,
    );
    if (!record(data.data))
      throw new WebError('网页正文无法读取，页面可能需要登录或不支持提取', 502);
    return pageResponse('firecrawl', url, this.apiKey, data.data, data.data.markdown);
  }
}

export class SearxngProvider implements WebProvider {
  /** 所选联网服务是否支持正文读取。 */
  readonly supportsFetch = false;
  constructor(
    private baseUrl: string,
    private request: typeof fetch = fetch,
  ) {}
  /** 按当前关键词执行检索。 */
  async search(query: string, maxResults: number, signal: AbortSignal) {
    /** 本次调用的接口地址。 */
    const endpoint = new URL(`${this.baseUrl}/search`);
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('safesearch', '1');
    /** 当前处理的数据。 */
    const data = await requestJson(
      'SearXNG',
      this.request,
      endpoint.href,
      { headers: { Accept: 'application/json' } },
      signal,
    );
    if (!Array.isArray(data.results)) throw new WebError('SearXNG 返回了无效结果结构', 502);
    return searchResponse('searxng', data.results, maxResults, '', (row) => ({
      title: row.title,
      url: row.url,
      snippet: row.content,
      publishedAt: row.publishedDate,
    }));
  }
}

/** 根据配置选择联网搜索服务实现。 */
export const createWebProvider = (config: ProviderConfig, request: typeof fetch): WebProvider => {
  switch (config.provider) {
    case 'tavily':
      return new TavilyProvider(config.apiKey, request);
    case 'firecrawl':
      return new FirecrawlProvider(config.apiKey, request);
    case 'exa':
      return new ExaProvider(config.apiKey, request);
    case 'brave':
      return new BraveProvider(config.apiKey, request);
    case 'searxng':
      return new SearxngProvider(config.baseUrl, request);
  }
};
