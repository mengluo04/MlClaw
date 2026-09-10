import { createApp } from './app.js';
import { readConfig } from './config/index.js';

try {
  const config = readConfig();
  const { app } = await createApp(config, true);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { app.close().catch(() => { process.exitCode = 1; }); });
  }
  try { await app.listen({ port: config.port, host: config.host }); }
  catch { await app.close(); throw new Error('服务启动失败，请检查监听地址与端口'); }
} catch (error) {
  console.error(error instanceof Error ? error.message : '服务初始化失败');
  process.exitCode = 1;
}
