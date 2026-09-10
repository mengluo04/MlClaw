import { ToolError } from '../tools/files.js';

export class WebError extends ToolError {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export interface SearchResult { title: string; url: string; snippet: string; publishedAt: string | null; truncated: boolean }
export interface SearchResponse { results: SearchResult[]; fetchedAt: string; truncated: boolean; source: 'tavily'; referenceOnly: true }
export interface PageResponse { title: string | null; url: string; content: string; fetchedAt: string; truncated: boolean; source: 'tavily'; referenceOnly: true }
export interface WebProvider {
  search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResponse>;
  extract(url: string, signal: AbortSignal): Promise<PageResponse>;
}
