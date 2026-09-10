import { resolve } from 'node:path';
export interface Config {
  host: string; port: number; databasePath: string; origin: string;
  secureCookie: boolean; adminUsername: string; adminPassword?: string; sessionSeconds: number;
  workspacePath?: string;
  executorUrl?: string; executorToken?: string;
  logLevel?: 'info' | 'warn' | 'error';
  serveWeb?: boolean;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为有效端口');
  const origin = env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('APP_ORIGIN 必须是无路径的 HTTP(S) 来源');
  const secureCookie = env.NODE_ENV === 'production';
  if (secureCookie && url.protocol !== 'https:') throw new Error('生产环境 APP_ORIGIN 必须使用 HTTPS');
  const executorUrl = env.EXECUTOR_URL || undefined; const executorToken = env.EXECUTOR_TOKEN || undefined;
  if (executorUrl) { const target = new URL(executorUrl); if (target.origin !== executorUrl || !['http:', 'https:'].includes(target.protocol) || (target.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) || !executorToken || executorToken.length < 32) throw new Error('执行服务要求有效本机 HTTP 或 HTTPS 来源及至少 32 字符令牌'); }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (env.SERVE_WEB !== undefined && !['true', 'false'].includes(env.SERVE_WEB)) throw new Error('SERVE_WEB 必须为 true 或 false');
  if (!['info', 'warn', 'error'].includes(logLevel)) throw new Error('LOG_LEVEL 必须为 info、warn 或 error');
  return { host: env.HOST ?? '127.0.0.1', port, databasePath: resolve(env.DATABASE_PATH ?? 'data/mlclaw.sqlite'), workspacePath: resolve(env.WORKSPACE_PATH ?? 'workspace'), origin, secureCookie, adminUsername: env.ADMIN_USERNAME ?? 'admin', adminPassword: env.ADMIN_PASSWORD, sessionSeconds: 86400, executorUrl, executorToken, logLevel: logLevel as Config['logLevel'], serveWeb: env.SERVE_WEB === 'true' };
}
