import { setImmediate } from 'node:timers/promises';

/** 缓存中的流数据也要定期交还事件循环，让 HTTP、SSE 定时器和取消得到处理。 */
export const streamCheckpoint = () => {
  let count = 0;
  let deadline = performance.now() + 8;
  return async () => {
    if (++count < 64 && performance.now() < deadline) return;
    await setImmediate();
    count = 0;
    deadline = performance.now() + 8;
  };
};
