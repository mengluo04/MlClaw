import { ContextLengthError, ProviderError, type Provider } from './types.js';

/** 只重试尚未产生有效输出的当前模型请求；上层工具循环不会重新执行。 */
export const recoveringProvider = (
  provider: Provider,
  recover: (messages: Parameters<Provider['stream']>[0], signal: AbortSignal) => Promise<void>,
): Provider => ({
  async *stream(messages, tools, signal) {
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const part of provider.stream(messages, tools, signal)) {
          signal.throwIfAborted();
          yielded = true;
          yield part;
        }
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ContextLengthError)) throw error;
        if (yielded)
          throw new ProviderError(
            '模型在输出过程中报告上下文超限，已保留输出；请手动生成摘要后继续',
          );
        if (attempt >= 2)
          throw new ProviderError(
            '自动压缩后模型仍提示上下文超限；请精简当前问题或助手配置，或切换更大容量模型',
          );
        await recover(messages, signal);
      }
    }
  },
});
