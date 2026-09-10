import { resolve } from 'node:path';
import { createExecutor } from './app.js';

try {
  const token = process.env.EXECUTOR_TOKEN ?? '';
  const image = process.env.EXECUTOR_IMAGE ?? '';
  if (!image || image.startsWith('-') || /\s/.test(image)) throw new Error('必须配置管理员审核的 EXECUTOR_IMAGE');
  const port = Number(process.env.EXECUTOR_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('执行服务端口无效');
  const { app } = await createExecutor({ workspacePath: resolve(process.env.WORKSPACE_PATH ?? '../server/workspace'), databasePath: resolve(process.env.EXECUTOR_DATABASE_PATH ?? 'data/executor.sqlite'), token, image, host: '127.0.0.1', port });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  await app.listen({ host: '127.0.0.1', port });
} catch { console.error('执行服务启动失败，请检查令牌、镜像、数据库和 Docker 配置'); process.exitCode = 1; }
