import { isIP } from 'node:net';
import { record } from '../providers/types.js';
import { formatSystemTime } from '../time.js';
import { WebError, type WebProvider, type SearchResponse, type PageResponse } from './types.js';

// 共享 URL 形式检查；直连抓取还必须通过 fetch.ts 的 DNS 固定与逐跳地址检查。
export const publicUrl = (input: string): string => {
  /** 当前请求或资源地址。 */
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebError('请输入有效的公开网页 URL');
  }
  /** 服务主机地址。 */
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    input.length > 2048 ||
    /[\x00-\x20\x7f\\]/.test(input) ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    isIP(host.replace(/^\[|\]$/g, '')) ||
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)
  ) {
    throw new WebError('仅支持不含凭据、IP 或自定义端口的公开 HTTP(S) 网页 URL');
  }
  url.hash = '';
  if (url.href.length > 2048) throw new WebError('网页 URL 编码后超过 2048 字符限制');
  return url.href;
};

export class TavilyProvider implements WebProvider {
  /** 所选联网服务是否支持正文读取。 */
  readonly supportsFetch = true;
  constructor(
    private apiKey: string,
    private request: typeof fetch = fetch,
  ) {}
  /** 清理返回文本并限制可见内容。 */
  private clean(value: string, limit: number) {
    return value
      .split(this.apiKey)
      .join('[已脱敏]')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      .slice(0, limit);
  }
  /** 校验或生成当前请求地址。 */
  private url(value: unknown): string {
    if (typeof value !== 'string' || value.includes(this.apiKey))
      throw new WebError('联网服务返回了无效来源 URL', 502);
    return publicUrl(value);
  }
  /** 发送 POST 请求。 */
  private async post(
    path: 'search' | 'extract',
    body: object,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    try {
      /** 请求返回的响应。 */
      const response = await this.request(`https://api.tavily.com/${path}`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          throw new WebError('Tavily 认证失败，请检查 API Key', 502);
        if (response.status === 429 || response.status === 432 || response.status === 433)
          throw new WebError('Tavily 请求受限或额度不足，请稍后重试并检查额度', 502);
        throw new WebError(`Tavily 服务请求失败（HTTP ${response.status}）`, 502);
      }
      /** 流数据读取器。 */
      const reader = response.body?.getReader();
      if (!reader) throw new WebError('Tavily 返回了空响应', 502);
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
          if (size > 1024 * 1024) throw new WebError('Tavily 响应超过 1 MiB 限制', 502);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      signal.throwIfAborted();
      /** 当前处理的值。 */
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new WebError('Tavily 返回了无效 JSON', 502);
      }
      if (!record(value) || !Array.isArray(value.results))
        throw new WebError('Tavily 返回了无效结果结构', 502);
      return value;
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      signal.throwIfAborted();
      if (error instanceof WebError) throw error;
      throw new WebError('Tavily 连接失败，请检查网络后重试', 502);
    }
  }
  /** 按当前关键词执行检索。 */
  async search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResponse> {
    /** 当前处理的数据。 */
    const data = await this.post(
      'search',
      {
        query,
        max_results: maxResults,
        search_depth: 'basic',
        topic: 'general',
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        auto_parameters: false,
      },
      signal,
    );
    /** 查询返回的记录列表。 */
    const rows = data.results as unknown[];
    /** 本次处理结果列表。 */
    const results: SearchResponse['results'] = [];
    for (/* 逐项处理当前数据库记录。 */ const row of rows.slice(0, maxResults)) {
      if (!record(row) || typeof row.title !== 'string' || typeof row.content !== 'string')
        throw new WebError('Tavily 搜索结果字段无效', 502);
      /** 当前请求或资源地址。 */
      let url: string;
      try {
        url = this.url(row.url);
      } catch {
        continue;
      }
      results.push({
        title: this.clean(row.title, 200),
        url,
        snippet: this.clean(row.content, 700),
        publishedAt:
          typeof row.published_date === 'string' ? this.clean(row.published_date, 80) : null,
        truncated: row.title.length > 200 || row.content.length > 700,
      });
    }
    // 保留完整 JSON 和来源字段，避免工具层通用截断破坏来源链接。
    while (JSON.stringify(results).length > 14000) results.pop();
    return {
      results,
      fetchedAt: formatSystemTime(),
      source: 'tavily',
      referenceOnly: true,
      truncated: rows.length > results.length || results.some((result) => result.truncated),
    };
  }
  /** 提取响应中可用的内容。 */
  async extract(input: string, signal: AbortSignal): Promise<PageResponse> {
    /** 当前请求或资源地址。 */
    const url = publicUrl(input);
    /** 当前处理的数据。 */
    const data = await this.post(
      'extract',
      { urls: [url], extract_depth: 'basic', format: 'text', include_images: false, timeout: 5 },
      signal,
    );
    /** 查询返回的记录列表。 */
    const rows = data.results as unknown[];
    if (!rows.length) throw new WebError('网页正文无法读取，页面可能需要登录或不支持提取', 502);
    /** 当前数据库记录。 */
    const row = rows[0];
    if (!record(row) || typeof row.raw_content !== 'string' || !row.raw_content.trim())
      throw new WebError('Tavily 未返回有效网页正文', 502);
    return {
      title: typeof row.title === 'string' ? this.clean(row.title, 200) : null,
      url: this.url(row.url),
      content: this.clean(row.raw_content, Infinity),
      fetchedAt: formatSystemTime(),
      truncated: row.truncated === true,
      source: 'tavily',
      referenceOnly: true,
    };
  }
}
