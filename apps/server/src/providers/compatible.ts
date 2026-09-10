import type { ModelConfig } from './types.js';
import { ProviderError, record, type ModelMessage, type Provider, type ModelEvent, type ToolDefinition, type ToolCall, type Usage } from './types.js';

// 流式 UTF-8 解码，支持 LF/CRLF 跨分块；每帧和整个响应均设置上限。
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = ''; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      total += value.byteLength;
      if (total > 2 * 1024 * 1024) throw new ProviderError('模型响应超过大小上限');
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        if (frame.length > 131072) throw new ProviderError('模型事件超过大小上限');
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (buffer.length > 131072) throw new ProviderError('模型事件超过大小上限');
    }
    if (buffer.trim()) throw new ProviderError('模型流意外中断');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class CompatibleProvider implements Provider {
  constructor(private config: ModelConfig, private timeoutMs = 60000) {}
  async *stream(messages: ModelMessage[], tools: ToolDefinition[], signal: AbortSignal): AsyncGenerator<ModelEvent> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.config.model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: 2048, ...(tools.length ? { tools } : {}) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(response.status === 401 || response.status === 403 ? '模型服务鉴权失败' : response.status === 429 ? '模型服务请求过于频繁，请稍后手动重试' : `模型服务失败（HTTP ${response.status}）`);
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw new ProviderError('模型服务未返回事件流'); }
      const calls = new Map<number, ToolCall>(); let usage: Usage | undefined; let finish = ''; let output = 0;
      for await (const data of parseSse(response.body)) {
        combined.throwIfAborted();
        if (data === '[DONE]') {
          if (!['stop', 'tool_calls'].includes(finish)) throw new ProviderError(finish === 'length' ? '模型输出达到预算上限' : '模型流未正常完成');
          if (finish === 'tool_calls' && !calls.size) throw new ProviderError('模型工具调用缺失');
          if (calls.size && finish !== 'tool_calls') throw new ProviderError('模型工具调用未完整结束');
          const ids = new Set<string>();
          for (const call of calls.values()) {
            if (!/^[\w-]{1,200}$/.test(call.id) || !/^[\w-]{1,100}$/.test(call.function.name) || ids.has(call.id)) throw new ProviderError('模型工具调用格式无效');
            ids.add(call.id);
          }
          yield { type: 'complete', calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call), usage }; return;
        }
        const chunk: unknown = JSON.parse(data);
        if (!record(chunk) || chunk.error || !Array.isArray(chunk.choices)) throw new ProviderError('模型事件格式无效');
        if (record(chunk.usage)) {
          const { prompt_tokens, completion_tokens, total_tokens } = chunk.usage;
          if ([prompt_tokens, completion_tokens, total_tokens].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) usage = { prompt_tokens: Number(prompt_tokens), completion_tokens: Number(completion_tokens), total_tokens: Number(total_tokens) };
        }
        for (const choice of chunk.choices) {
          if (!record(choice) || choice.index !== 0 || !record(choice.delta)) throw new ProviderError('模型增量格式无效');
          if (choice.finish_reason != null) {
            if (typeof choice.finish_reason !== 'string' || finish) throw new ProviderError('模型结束事件无效');
            finish = choice.finish_reason;
          }
          const delta = choice.delta;
          if (delta.content != null) {
            if (typeof delta.content !== 'string') throw new ProviderError('模型文本格式无效');
            output += delta.content.length; if (output > 32768) throw new ProviderError('模型输出超过大小上限');
            if (delta.content) yield { type: 'delta', text: delta.content };
          }
          if (delta.tool_calls != null) {
            if (!Array.isArray(delta.tool_calls)) throw new ProviderError('工具增量格式无效');
            for (const part of delta.tool_calls) {
              if (!record(part) || typeof part.index !== 'number' || !Number.isInteger(part.index) || part.index < 0 || part.index >= 8) throw new ProviderError('工具索引无效');
              const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (part.type != null && part.type !== 'function') throw new ProviderError('工具类型无效');
              if (part.id != null) { if (typeof part.id !== 'string') throw new ProviderError('工具 ID 无效'); call.id += part.id; }
              if (part.function != null) {
                if (!record(part.function)) throw new ProviderError('工具函数无效');
                for (const key of ['name', 'arguments'] as const) if (part.function[key] != null) {
                  if (typeof part.function[key] !== 'string') throw new ProviderError('工具参数片段无效');
                  call.function[key] += part.function[key];
                }
              }
              if (call.function.arguments.length > 65536 || call.function.name.length > 100 || call.id.length > 200) throw new ProviderError('工具调用超过上限');
              calls.set(part.index, call);
            }
          }
        }
      }
      throw new ProviderError('模型流意外中断');
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (combined.aborted) throw new ProviderError('模型服务响应超时');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('模型服务连接或流解析失败');
    }
  }
}
