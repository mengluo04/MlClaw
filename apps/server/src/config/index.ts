import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
export interface Config {
  host: string;
  port: number;
  databasePath: string;
  /** 仅供内部测试注入；启动配置不提供这些覆盖项。 */
  origin?: string;
  secureCookie?: boolean;
  adminUsername?: string;
  adminPassword?: string;
  sessionSeconds: number;
  workspacePath?: string;
  logLevel?: 'info' | 'warn' | 'error';
}
/** 固定运行约定；业务设置统一保存在数据库中。 */
export const readConfig = (
  env: NodeJS.ProcessEnv = process.env,
  directory = process.cwd(),
): Config => {
  // 仅检查旧存储位置，避免升级后静默使用空库；不加载任何旧启动参数。
  const legacyFile = resolve(directory, '.env');
  /** 旧版环境配置内容，仅用于存储迁移检查。 */
  const legacyEnv = existsSync(legacyFile) ? parseEnv(readFileSync(legacyFile, 'utf8')) : {};
  /** 旧版 JSON 配置文件路径。 */
  const legacyJson = resolve(directory, 'config.json');
  /** 修改前的数据。 */
  let previous: Record<string, unknown> = {};
  if (existsSync(legacyJson)) {
    try {
      /** 从 JSON 文本解析的结构化数据，后续仍需按业务规则校验。 */
      const value: unknown = JSON.parse(readFileSync(legacyJson, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      previous = value as Record<string, unknown>;
    } catch {
      throw new Error('旧 config.json 无法检查，请核对旧存储目录并移除该文件后启动');
    }
  }
  for (/* 逐项处理当前索引或字段键、JSON 数据索引或字段键、固定操作使用的路径。 */ const [
    key,
    jsonKey,
    fixedPath,
  ] of [
    ['DATABASE_PATH', 'databasePath', 'data/mlclaw.sqlite'],
    ['WORKSPACE_PATH', 'workspacePath', 'workspace'],
  ] as const) {
    for (/* 逐项处理当前处理的值。 */ const value of [
      env[key],
      legacyEnv[key],
      previous[jsonKey],
    ]) {
      if (
        value !== undefined &&
        value !== '' &&
        (typeof value !== 'string' || resolve(directory, value) !== resolve(directory, fixedPath))
      )
        throw new Error(`旧版存储路径与固定的 ${fixedPath} 不同，请停机迁移并移除旧路径配置后启动`);
    }
  }
  return {
    host: '0.0.0.0',
    port: 3000,
    databasePath: resolve(directory, 'data/mlclaw.sqlite'),
    workspacePath: resolve(directory, 'workspace'),
    sessionSeconds: 86400,
  };
};
