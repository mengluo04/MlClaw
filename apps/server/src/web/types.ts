import { ToolError } from '../tools/files.js';
import type { WebProviderName } from '@mlclaw/shared';

export class WebError extends ToolError {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  truncated: boolean;
}
export interface SearchResponse {
  results: SearchResult[];
  fetchedAt: string;
  truncated: boolean;
  source: WebProviderName;
  referenceOnly: true;
}
export interface PageResponse {
  title: string | null;
  url: string;
  content: string;
  fetchedAt: string;
  truncated: boolean;
  source: WebProviderName | 'direct';
  finalUrl?: string;
  contentType?: string;
  status?: number;
  extractor?: 'raw' | 'readability' | 'json';
  referenceOnly: true;
}
export interface WebProvider {
  readonly supportsFetch: boolean;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResponse>;
  extract?(url: string, signal: AbortSignal): Promise<PageResponse>;
}

/** 判断指定联网服务是否需要 API 密钥。 */
export const providerNeedsApiKey = (provider: WebProviderName) => {
  return provider !== 'searxng';
};

/** 判断指定联网服务是否支持正文读取。 */
export const providerSupportsFetch = (provider: WebProviderName) => {
  return provider === 'tavily' || provider === 'firecrawl' || provider === 'exa';
};
