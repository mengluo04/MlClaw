import { isIP } from 'node:net';
import { record } from '../providers/types.js';
import { formatSystemTime } from '../time.js';
import { WebError, type WebProvider, type SearchResponse, type PageResponse } from './types.js';

// URL 仅作为数据发送到 Tavily；本服务不解析 DNS 或直接抓取目标网页。
export function publicUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new WebError('请输入有效的公开网页 URL'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (input.length > 2048 || /[\x00-\x20\x7f\\]/.test(input) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)) {
    throw new WebError('仅支持不含凭据、IP 或自定义端口的公开 HTTP(S) 网页 URL');
  }
  url.hash = '';
  if (url.href.length > 2048) throw new WebError('网页 URL 编码后超过 2048 字符限制');
  return url.href;
}

export class TavilyProvider implements WebProvider {
  constructor(private apiKey: string, private request: typeof fetch = fetch) {}
  private clean(value: string, limit: number) { return value.split(this.apiKey).join('[已脱敏]').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, limit); }
  private url(value: unknown): string {
    if (typeof value !== 'string' || value.includes(this.apiKey)) throw new WebError('联网服务返回了无效来源 URL', 502);
    return publicUrl(value);
  }
  private async post(path: 'search' | 'extract', body: object, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    try {
      const response = await this.request(`https://api.tavily.com/${path}`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new WebError('Tavily 认证失败，请检查 API Key', 502);
        if (response.status === 429 || response.status === 432 || response.status === 433) throw new WebError('Tavily 请求受限或额度不足，请稍后重试并检查额度', 502);
        throw new WebError(`Tavily 服务请求失败（HTTP ${response.status}）`, 502);
      }
      const reader = response.body?.getReader(); if (!reader) throw new WebError('Tavily 返回了空响应', 502);
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 1024 * 1024) throw new WebError('Tavily 响应超过 1 MiB 限制', 502);
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      signal.throwIfAborted();
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new WebError('Tavily 返回了无效 JSON', 502); }
      if (!record(value) || !Array.isArray(value.results)) throw new WebError('Tavily 返回了无效结果结构', 502);
      return value;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof WebError) throw error;
      throw new WebError('Tavily 连接失败，请检查网络后重试', 502);
    }
  }
  async search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResponse> {
    const data = await this.post('search', { query, max_results: maxResults, search_depth: 'basic', topic: 'general',
      include_answer: false, include_raw_content: false, include_images: false, auto_parameters: false }, signal);
    const rows = data.results as unknown[];
    const results: SearchResponse['results'] = [];
    for (const row of rows.slice(0, maxResults)) {
      if (!record(row) || typeof row.title !== 'string' || typeof row.content !== 'string') throw new WebError('Tavily 搜索结果字段无效', 502);
      let url: string; try { url = this.url(row.url); } catch { continue; }
      results.push({ title: this.clean(row.title, 200), url, snippet: this.clean(row.content, 700),
        publishedAt: typeof row.published_date === 'string' ? this.clean(row.published_date, 80) : null,
        truncated: row.title.length > 200 || row.content.length > 700 });
    }
    // 保留完整 JSON 和来源字段，避免工具层通用截断破坏来源链接。
    while (JSON.stringify(results).length > 14000) results.pop();
    return { results, fetchedAt: formatSystemTime(), source: 'tavily', referenceOnly: true,
      truncated: rows.length > results.length || results.some(result => result.truncated) };
  }
  async extract(input: string, signal: AbortSignal): Promise<PageResponse> {
    const url = publicUrl(input);
    const data = await this.post('extract', { urls: [url], extract_depth: 'basic', format: 'text', include_images: false, timeout: 5 }, signal);
    const rows = data.results as unknown[];
    if (!rows.length) throw new WebError('网页正文无法读取，页面可能需要登录或不支持提取', 502);
    const row = rows[0];
    if (!record(row) || typeof row.raw_content !== 'string' || !row.raw_content.trim()) throw new WebError('Tavily 未返回有效网页正文', 502);
    return { title: typeof row.title === 'string' ? this.clean(row.title, 200) : null, url: this.url(row.url),
      content: this.clean(row.raw_content, 6000), fetchedAt: formatSystemTime(), truncated: row.raw_content.length > 6000,
      source: 'tavily', referenceOnly: true };
  }
}
