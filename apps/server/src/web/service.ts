import type { DatabaseSync } from 'node:sqlite';
import type { WebConnectionTest } from '@mlclaw/shared';
import { getWebConfig, webConfigReady, type WebConfig } from './store.js';
import { WebError, type SearchResponse, type PageResponse, type WebProvider } from './types.js';
import type { ToolPolicy } from '../tools/registry.js';
import { createWebProvider } from './providers.js';
import { boundPage, directFetch, FetchBlockedError, type DirectFetch } from './fetch.js';

export class WebService {
  /** 进行中的联网请求控制器与所属用户映射。 */
  private active = new Map<AbortController, string>();
  /** 按用户保存的联网连接测试频率控制状态。 */
  private tests = new Map<string, number>();
  /** 服务是否已经关闭，阻止后续新请求。 */
  private closed = false;
  constructor(
    private db: DatabaseSync,
    private request: typeof fetch = fetch,
    private fetchDirect: DirectFetch = directFetch,
  ) {}
  /** 固定用户联网配置和工具权限，创建任务级联网会话。 */
  session(userId: string, policy: ToolPolicy) {
    return new WebSession(this, userId, getWebConfig(this.db, userId), policy);
  }
  /** 读取当前有效记录。 */
  current(userId: string) {
    return getWebConfig(this.db, userId);
  }
  /** 优先直连，普通网络或 HTML 提取失败才使用已配置的正文服务，绝不调用搜索。 */
  async fetchPage(url: string, provider: WebProvider, signal: AbortSignal, maxChars?: number) {
    signal.throwIfAborted();
    const directSignal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    try {
      const result = await this.fetchDirect(url, directSignal);
      directSignal.throwIfAborted();
      signal.throwIfAborted();
      return boundPage(result, maxChars);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof FetchBlockedError) throw error;
      if (!provider.extract) throw new WebError('直接读取失败，当前服务没有正文提取备用能力', 502);
      const result = await provider.extract(url, signal);
      signal.throwIfAborted();
      return boundPage(result, maxChars);
    }
  }
  /** 取消当前执行并更新相关状态。 */
  cancel(userId?: string) {
    for (/* 逐项处理用于主动取消当前操作的控制器、当前资源所属用户或绑定身份。 */ const [
      controller,
      owner,
    ] of this.active)
      if (!userId || owner === userId)
        controller.abort(new WebError('联网请求已停止，配置已变更或服务正在关闭'));
  }
  /** 关闭当前资源或编辑界面。 */
  close() {
    this.closed = true;
    this.cancel();
  }
  /** 执行当前操作并返回执行结果。 */
  async run<T>(
    userId: string,
    config: WebConfig,
    signal: AbortSignal,
    fn: (provider: WebProvider, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new WebError('联网服务正在关闭，不能启动新请求');
    /** 用于主动取消当前操作的控制器。 */
    const controller = new AbortController();
    this.active.set(controller, userId);
    /** 合并主动取消与超时限制的信号。 */
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(8000)]);
    try {
      combined.throwIfAborted();
      /** 当前模型或联网服务提供商。 */
      const provider = createWebProvider(config, this.request);
      /** 本次处理结果。 */
      const result = await fn(provider, combined);
      combined.throwIfAborted();
      return result;
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      signal.throwIfAborted();
      if (controller.signal.aborted) throw new WebError('联网请求已停止，配置已变更或服务正在关闭');
      if (combined.aborted) throw new WebError('联网请求超时，请稍后重试', 502);
      if (error instanceof WebError) throw error;
      throw new WebError('联网请求失败，请稍后重试', 502);
    } finally {
      this.active.delete(controller);
    }
  }
  /** 执行当前配置的连接验证并显示结果。 */
  async test(userId: string, expectedVersion: number): Promise<WebConnectionTest> {
    /** 当前流程使用的配置。 */
    const config = this.current(userId);
    if (config.version !== expectedVersion)
      throw new WebError('联网配置已被其他页面更新，请重新加载后测试', 409);
    if (!webConfigReady(config)) throw new WebError('请先保存当前搜索服务的连接配置');
    /** 本次执行的开始时间或启动状态。 */
    const started = Date.now();
    if (started - (this.tests.get(userId) ?? 0) < 10000)
      throw new WebError('连接测试过于频繁，请等待 10 秒后重试', 429);
    this.tests.set(userId, started);
    /** 本次处理结果。 */
    const result = await this.run(
      userId,
      config,
      new AbortController().signal,
      (provider, signal) => provider.search('MlClaw web search connection test', 1, signal),
    );
    return { ok: true, durationMs: Date.now() - started, resultCount: result.results.length };
  }
}

export class WebSession {
  constructor(
    private service: WebService,
    private userId: string,
    readonly config: WebConfig,
    private policy: ToolPolicy,
  ) {}
  /** 判断当前任务是否允许使用指定能力。 */
  allows(fetchPage = false, policy: ToolPolicy = this.policy) {
    /** 当前有效数据。 */
    const current = this.service.current(this.userId);
    return (
      this.config.enabled &&
      webConfigReady(this.config) &&
      current.enabled &&
      current.provider === this.config.provider &&
      current.apiKey === this.config.apiKey &&
      current.baseUrl === this.config.baseUrl &&
      webConfigReady(current) &&
      (!fetchPage || this.config.supportsFetch) &&
      (!fetchPage || (this.config.allowFetch && current.allowFetch)) &&
      ((this.policy !== 'readonly' && policy !== 'readonly') ||
        (this.config.allowSchedules && current.allowSchedules))
    );
  }
  /** 检查当前操作的访问条件，不满足时拒绝执行。 */
  assertAllowed(fetchPage = false, policy: ToolPolicy = this.policy) {
    if (!this.allows(fetchPage, policy))
      throw new WebError('联网工具未启用或权限已撤销，请检查联网搜索配置');
  }
  /** 执行已准备的操作并返回结果。 */
  async execute(
    name: 'web_search' | 'web_fetch',
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    this.assertAllowed(name === 'web_fetch');
    signal.throwIfAborted();
    return this.service.run<SearchResponse | PageResponse>(
      this.userId,
      this.config,
      signal,
      (provider, combined) =>
        name === 'web_search'
          ? provider.search(
              String(args.query).trim(),
              typeof args.maxResults === 'number' ? args.maxResults : 5,
              combined,
            )
          : this.service.fetchPage(
              String(args.url),
              provider,
              combined,
              typeof args.maxChars === 'number' ? args.maxChars : undefined,
            ),
    );
  }
}
