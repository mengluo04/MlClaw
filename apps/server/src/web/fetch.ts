import { lookup } from 'node:dns/promises';
import { Agent, fetch as httpFetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { publicUrl } from './tavily.js';
import { WebError, type PageResponse } from './types.js';
import { formatSystemTime } from '../time.js';

/** 网络边界或非文本响应拒绝不能通过第三方备用路径绕过。 */
export class FetchBlockedError extends WebError {}
/** 每次解析返回的全部地址；实际连接固定在这些已校验地址上。 */
export type FetchLookup = (host: string) => Promise<{ address: string; family: number }[]>;
export type DirectFetch = (url: string, signal: AbortSignal) => Promise<PageResponse>;
/** 非全局单播及过渡网络不允许作为模型请求目标。 */
export const isPublicAddress = (address: string) => {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  const excluded =
    parsed.kind() === 'ipv4' ? ['192.0.0.0/24', '192.88.99.0/24'] : ['2001::/23', '2002::/16'];
  if (parsed.kind() === 'ipv6' && !parsed.match(ipaddr.parseCIDR('2000::/3'))) return false;
  return !excluded.some((cidr) => parsed.match(ipaddr.parseCIDR(cidr)));
};

/** 检查 URL，统一将边界拒绝标记为不可降级错误。 */
const checkedUrl = (input: string) => {
  try {
    return publicUrl(input);
  } catch {
    throw new FetchBlockedError('仅允许读取不含凭据、IP 或自定义端口的公开 HTTP(S) URL');
  }
};

/** 将 DNS 等不支持 AbortSignal 的操作纳入取消等待，迟到结果不发起请求。 */
const abortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
};

/** 仅按调用方显式指定的长度截断；省略参数时返回已抓取的全部正文。 */
export const boundPage = (page: PageResponse, maxChars?: number): PageResponse => {
  if (maxChars === undefined) return page;
  return {
    ...page,
    content: page.content.slice(0, maxChars),
    truncated: page.truncated || page.content.length > maxChars,
  };
};

/** OpenClaw 同类流程：受保护 GET → 按内容类型读取/提取；不运行脚本或加载页面子资源。 */
export const createDirectFetch =
  (
    resolve: FetchLookup = (host) => lookup(host, { all: true, verbatim: true }),
    request: typeof httpFetch = httpFetch,
  ): DirectFetch =>
  async (input, signal) => {
    const original = checkedUrl(input);
    let url = original;
    const visited = new Set<string>();
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted();
      url = checkedUrl(url);
      if (visited.has(url)) throw new FetchBlockedError('网页重定向形成循环');
      visited.add(url);
      const hostname = new URL(url).hostname;
      const addresses = await abortable(resolve(hostname), signal);
      signal.throwIfAborted();
      if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
        throw new FetchBlockedError('目标域名解析到内网、保留或非公开地址，已拒绝读取');
      /** 自定义 lookup 不再访问 DNS，防止校验与连接之间发生地址替换。 */
      const dispatcher = new Agent({
        connect: {
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          },
        },
      });
      let response: Awaited<ReturnType<typeof httpFetch>> | undefined;
      try {
        response = await request(url, {
          method: 'GET',
          redirect: 'manual',
          dispatcher,
          signal,
          headers: {
            'User-Agent': 'MlClaw/0.1 WebFetch',
            Accept: 'text/html,text/plain,application/json,text/markdown,*/*;q=0.5',
          },
        });
        signal.throwIfAborted();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || hop === 3) throw new FetchBlockedError('网页重定向无效或超过 3 次');
          try {
            url = checkedUrl(new URL(location, url).href);
          } catch {
            throw new FetchBlockedError('网页重定向指向不允许访问的地址');
          }
          continue;
        }
        if (!response.ok) throw new WebError(`直接读取失败（HTTP ${response.status}）`, 502);
        const header = response.headers.get('content-type') ?? 'application/octet-stream';
        const contentType = header.split(';')[0]!.trim().toLowerCase().slice(0, 256);
        if (
          /^(image|audio|video|font)\//.test(contentType) ||
          /(?:pdf|zip|gzip|tar|wasm)/.test(contentType)
        )
          throw new FetchBlockedError('目标是二进制文件，web_fetch 只读取文本');
        const reader = response.body?.getReader();
        if (!reader) throw new WebError('目标返回空响应', 502);
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        let truncated = false;
        try {
          while (true) {
            signal.throwIfAborted();
            const part = await abortable(reader.read(), signal);
            if (part.done) break;
            const remaining = 750000 - bytes;
            chunks.push(part.value.subarray(0, remaining));
            bytes += Math.min(part.value.byteLength, remaining);
            if (part.value.byteLength > remaining) {
              truncated = true;
              break;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        signal.throwIfAborted();
        const encoding = /charset\s*=\s*["']?([^\s;"']+)/i.exec(header)?.[1] ?? 'utf-8';
        let body: string;
        try {
          body = new TextDecoder(encoding, { fatal: true }).decode(Buffer.concat(chunks), {
            stream: truncated,
          });
        } catch {
          throw new FetchBlockedError('目标不是支持编码的文本，无法安全读取');
        }
        if (/[\x00-\x08\x0b\x0e-\x1f]/.test(body))
          throw new FetchBlockedError('目标包含二进制内容，无法作为文本读取');
        let content = body;
        let title: string | null = null;
        let extractor: 'raw' | 'readability' | 'json' = 'raw';
        if (['text/html', 'application/xhtml+xml'].includes(contentType)) {
          const [{ JSDOM }, { Readability }] = await Promise.all([
            import('jsdom'),
            import('@mozilla/readability'),
          ]);
          signal.throwIfAborted();
          /** jsdom 默认禁用脚本和外部资源；绝不传 runScripts/resources。 */
          const dom = new JSDOM(body, { url });
          try {
            const article = new Readability(dom.window.document, {
              maxElemsToParse: 20000,
            }).parse();
            if (!article?.textContent?.trim()) throw new WebError('网页本地正文提取失败', 502);
            content = article.textContent.trim();
            title = article.title?.slice(0, 200) ?? null;
            extractor = 'readability';
          } finally {
            dom.window.close();
          }
        } else if (contentType === 'application/json' || contentType.endsWith('+json')) {
          try {
            content = JSON.stringify(JSON.parse(body), null, 2);
            extractor = 'json';
          } catch {
            /* 不完整 JSON 保留原文并沿用截断标记。 */
          }
        }
        signal.throwIfAborted();
        return boundPage({
          title,
          url: original,
          finalUrl: url,
          content,
          contentType,
          status: response.status,
          extractor,
          fetchedAt: formatSystemTime(),
          truncated,
          source: 'direct',
          referenceOnly: true,
        });
      } finally {
        if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
        await dispatcher.destroy();
      }
    }
    throw new FetchBlockedError('网页重定向超过上限');
  };

export const directFetch = createDirectFetch();
