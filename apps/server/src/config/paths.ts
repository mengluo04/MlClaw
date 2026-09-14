import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 解析真实路径，用于路径边界比较。 */
const canonical = (path: string): string => {
  /** 解析后的绝对路径。 */
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  /** 用于检查存储边界的父目录。 */
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonical(parent), basename(absolute));
};
/** 验证工作目录与应用私有存储没有重叠。 */
export const assertPrivateStorage = (workspace: string, database: string) => {
  /** 本次操作的根目录。 */
  const root = canonical(workspace);
  /** 不允许通过工作区访问的应用私有文件。 */
  const protectedFiles = [
    resolve('config.json'),
    fileURLToPath(new URL('../../config.json', import.meta.url)),
    resolve('.env'),
    fileURLToPath(new URL('../../.env', import.meta.url)),
    ...(database === ':memory:' ? [] : [database]),
  ];
  for (/* 逐项处理当前处理的文件。 */ const file of protectedFiles) {
    /** 相对根目录的路径。 */
    const rel = relative(root, canonical(file));
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)))
      throw new Error('授权工作目录不能包含应用数据库或环境配置');
  }
};
