import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute); if (parent === absolute) return absolute;
  return join(canonical(parent), basename(absolute));
}
export function assertPrivateStorage(workspace: string, database: string) {
  const root = canonical(workspace);
  const protectedFiles = [resolve('.env'), fileURLToPath(new URL('../../.env', import.meta.url)), ...(database === ':memory:' ? [] : [database])];
  for (const file of protectedFiles) {
    const rel = relative(root, canonical(file));
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('授权工作目录不能包含应用数据库或环境配置');
  }
}
