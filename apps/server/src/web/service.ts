import type { DatabaseSync } from 'node:sqlite';
import type { WebConnectionTest } from '@mlclaw/shared';
import { getWebConfig, type WebConfig } from './store.js';
import { TavilyProvider } from './tavily.js';
import { WebError, type SearchResponse, type PageResponse, type WebProvider } from './types.js';
import type { ToolPolicy } from '../tools/registry.js';

export class WebService {
  private active = new Map<AbortController, string>();
  private tests = new Map<string, number>();
  private closed = false;
  constructor(private db: DatabaseSync, private request: typeof fetch = fetch) {}
  session(userId: string, policy: ToolPolicy) { return new WebSession(this, userId, getWebConfig(this.db, userId), policy); }
  current(userId: string) { return getWebConfig(this.db, userId); }
  cancel(userId?: string) {
    for (const [controller, owner] of this.active) if (!userId || owner === userId) controller.abort(new WebError('联网请求已停止，配置已变更或服务正在关闭'));
  }
  close() { this.closed = true; this.cancel(); }
  async run<T>(userId: string, config: WebConfig, signal: AbortSignal, fn: (provider: WebProvider, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new WebError('联网服务正在关闭，不能启动新请求');
    const controller = new AbortController(); this.active.set(controller, userId);
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(8000)]);
    try {
      combined.throwIfAborted();
      const result = await fn(new TavilyProvider(config.apiKey, this.request), combined);
      combined.throwIfAborted(); return result;
    } catch (error) {
      signal.throwIfAborted();
      if (controller.signal.aborted) throw new WebError('联网请求已停止，配置已变更或服务正在关闭');
      if (combined.aborted) throw new WebError('联网请求超时，请稍后重试', 502);
      if (error instanceof WebError) throw error;
      throw new WebError('联网请求失败，请稍后重试', 502);
    } finally { this.active.delete(controller); }
  }
  async test(userId: string, expectedVersion: number): Promise<WebConnectionTest> {
    const config = this.current(userId);
    if (config.version !== expectedVersion) throw new WebError('联网配置已被其他页面更新，请重新加载后测试', 409);
    if (!config.apiKey) throw new WebError('请先保存 Tavily API Key');
    const started = Date.now();
    if (started - (this.tests.get(userId) ?? 0) < 10000) throw new WebError('连接测试过于频繁，请等待 10 秒后重试', 429);
    this.tests.set(userId, started);
    const result = await this.run(userId, config, new AbortController().signal, (provider, signal) => provider.search('Tavily documentation', 1, signal));
    return { ok: true, durationMs: Date.now() - started, resultCount: result.results.length };
  }
}

export class WebSession {
  private calls = 0;
  constructor(private service: WebService, private userId: string, readonly config: WebConfig, private policy: ToolPolicy) {}
  allows(fetchPage = false, policy: ToolPolicy = this.policy) {
    const current = this.service.current(this.userId);
    return this.config.enabled && !!this.config.apiKey && current.enabled && current.apiKey === this.config.apiKey &&
      (!fetchPage || this.config.allowFetch && current.allowFetch) &&
      (this.policy !== 'readonly' && policy !== 'readonly' || this.config.allowSchedules && current.allowSchedules);
  }
  assertAllowed(fetchPage = false, policy: ToolPolicy = this.policy) { if (!this.allows(fetchPage, policy)) throw new WebError('联网工具未启用或权限已撤销，请检查联网搜索配置'); }
  async execute(name: 'web_search' | 'web_fetch', args: Record<string, unknown>, signal: AbortSignal) {
    this.assertAllowed(name === 'web_fetch'); signal.throwIfAborted();
    if (this.calls >= 6) throw new WebError('本任务已达到 6 次联网调用上限');
    this.calls++;
    return this.service.run<SearchResponse | PageResponse>(this.userId, this.config, signal, (provider, combined) => name === 'web_search'
      ? provider.search(String(args.query).trim(), typeof args.maxResults === 'number' ? args.maxResults : 5, combined)
      : provider.extract(String(args.url), combined));
  }
}
