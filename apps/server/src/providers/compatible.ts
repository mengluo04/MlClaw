import type { ModelConfig } from './types.js';
import { streamCheckpoint } from './stream-checkpoint.js';
import { normalizeToolCalls } from './tool-calls.js';
import { isContextLengthError, readContextError } from './context-error.js';
import {
  ProviderError,
  ContextLengthError,
  record,
  type ModelMessage,
  type Provider,
  type ModelEvent,
  type ToolDefinition,
  type ToolCall,
  type Usage,
} from './types.js';

// 流式 UTF-8 解码，支持 LF/CRLF 跨分块，不按响应或事件大小截断。
export const parseSse = async function* (body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  /** 流数据读取器。 */
  const reader = body.getReader();
  /** 流式文本解码器。 */
  const decoder = new TextDecoder('utf-8', { fatal: true });
  /** 跨分块保留的尚未组成完整 SSE 帧的文本。 */
  let buffer = '';
  const checkpoint = streamCheckpoint();
  try {
    while (true) {
      /** done：当前读取或执行是否结束；value：当前处理的值。 */
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      /** 当前正则匹配结果。 */
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        await checkpoint();
        /** 当前完整的流事件帧。 */
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        /** 完整 SSE 帧中合并后的 data 字段内容。 */
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
      }
    }
    if (buffer.trim()) throw new ProviderError('模型流意外中断');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

export class CompatibleProvider implements Provider {
  constructor(
    private config: ModelConfig,
    private timeoutMs = 60000,
  ) {}
  /** 流式返回模型事件并传播取消与错误。 */
  async *stream(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): AsyncGenerator<ModelEvent> {
    /** 合并主动取消与超时限制的信号。 */
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      /** 请求返回的响应。 */
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: combined,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length ? { tools } : {}),
        }),
      });
      if (!response.ok) {
        if ([400, 413, 422].includes(response.status) && (await readContextError(response)))
          throw new ContextLengthError();
        await response.body?.cancel();
        throw new ProviderError(
          response.status === 401 || response.status === 403
            ? '模型服务鉴权失败'
            : response.status === 429
              ? '模型服务请求过于频繁，请稍后手动重试'
              : `模型服务失败（HTTP ${response.status}）`,
        );
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new ProviderError('模型服务未返回事件流');
      }
      /** 按工具调用索引累计的名称与 JSON 参数。 */
      const calls = new Map<number, ToolCall>();
      /** 上游模型报告的输入、输出及总用量。 */
      let usage: Usage | undefined;
      /** 上游模型报告的结束原因。 */
      let finish = '';
      for await (/* 逐项处理当前处理的数据。 */ const data of parseSse(response.body)) {
        combined.throwIfAborted();
        if (data === '[DONE]') {
          if (!['stop', 'tool_calls'].includes(finish))
            throw new ProviderError(
              finish === 'length'
                ? '模型服务截断了本次输出，请缩短单次输出或在模型服务端提高输出额度；本轮工具调用未执行'
                : '模型流未正常完成',
            );
          if (finish === 'tool_calls' && !calls.size) throw new ProviderError('模型工具调用缺失');
          if (calls.size && finish !== 'tool_calls')
            throw new ProviderError('模型工具调用未完整结束');
          yield {
            type: 'complete',
            calls: normalizeToolCalls(
              [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
              tools,
            ),
            usage,
          };
          return;
        }
        /** 本次读取的数据分块。 */
        const chunk: unknown = JSON.parse(data);
        if (record(chunk) && chunk.error && isContextLengthError(chunk))
          throw new ContextLengthError();
        if (!record(chunk) || chunk.error || !Array.isArray(chunk.choices))
          throw new ProviderError('模型事件格式无效');
        if (record(chunk.usage)) {
          /** prompt_tokens：模型报告的输入 token 数；completion_tokens：模型报告的输出 token 数；total_tokens：模型报告的总 token 数。 */
          const { prompt_tokens, completion_tokens, total_tokens } = chunk.usage;
          if (
            [prompt_tokens, completion_tokens, total_tokens].every(
              (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0,
            )
          )
            usage = {
              prompt_tokens: Number(prompt_tokens),
              completion_tokens: Number(completion_tokens),
              total_tokens: Number(total_tokens),
            };
        }
        for (/* 逐项处理选择项。 */ const choice of chunk.choices) {
          if (!record(choice) || choice.index !== 0 || !record(choice.delta))
            throw new ProviderError('模型增量格式无效');
          if (choice.finish_reason != null) {
            if (typeof choice.finish_reason !== 'string' || finish)
              throw new ProviderError('模型结束事件无效');
            finish = choice.finish_reason;
          }
          /** 当前模型分块携带的增量内容。 */
          const delta = choice.delta;
          if (delta.content != null) {
            if (typeof delta.content !== 'string') throw new ProviderError('模型文本格式无效');
            if (delta.content) yield { type: 'delta', text: delta.content };
          }
          if (delta.tool_calls != null) {
            if (!Array.isArray(delta.tool_calls)) throw new ProviderError('工具增量格式无效');
            for (/* 逐项处理片段。 */ const part of delta.tool_calls) {
              if (
                !record(part) ||
                typeof part.index !== 'number' ||
                !Number.isSafeInteger(part.index) ||
                part.index < 0
              )
                throw new ProviderError('工具索引无效');
              /** 当前模型工具调用。 */
              const call = calls.get(part.index) ?? {
                id: '',
                type: 'function',
                function: { name: '', arguments: '' },
              };
              if (part.type != null && part.type !== 'function')
                throw new ProviderError('工具类型无效');
              if (part.id != null) {
                if (typeof part.id !== 'string') throw new ProviderError('工具 ID 无效');
                call.id += part.id;
              }
              if (part.function != null) {
                if (!record(part.function)) throw new ProviderError('工具函数无效');
                for (/* 逐项处理当前索引或字段键。 */ const key of ['name', 'arguments'] as const)
                  if (part.function[key] != null) {
                    if (typeof part.function[key] !== 'string')
                      throw new ProviderError('工具参数片段无效');
                    call.function[key] += part.function[key];
                  }
              }
              calls.set(part.index, call);
            }
          }
        }
      }
      throw new ProviderError('模型流意外中断');
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      if (signal.aborted) throw signal.reason;
      if (combined.aborted) throw new ProviderError('模型服务响应超时');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('模型服务连接或流解析失败');
    }
  }
}
