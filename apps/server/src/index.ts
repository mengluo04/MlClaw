import { createApp } from './app.js';
import { readConfig } from './config/index.js';

try {
  /** 当前流程使用的配置。 */
  const config = readConfig();
  /** 应用实例。 */
  const { app } = await createApp(config, true);
  for (/* 逐项处理当前操作的取消信号。 */ const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch {
    await app.close();
    throw new Error('服务启动失败，请检查监听地址与端口');
  }
} catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
  console.error(error instanceof Error ? error.message : '服务初始化失败');
  process.exitCode = 1;
}
