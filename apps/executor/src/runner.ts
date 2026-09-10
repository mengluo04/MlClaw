import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { CommandRequest, CommandResult } from '@mlclaw/shared';

export interface ExecutorConfig { workspacePath: string; databasePath: string; token: string; image: string; host: string; port: number }
export interface Runner { execute(request: CommandRequest, signal: AbortSignal): Promise<CommandResult>; cleanup(id: string): Promise<void> }
export function containerName(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('执行 ID 无效'); return `mlclaw-job-${id}`; }
export function commandDirectory(root: string, cwd: string) {
  if (!cwd || cwd.length > 500 || isAbsolute(cwd) || /[\\\x00-\x1f<>:"|?*,]/.test(cwd)) throw new Error('命令目录无效');
  const base = realpathSync(root); let path = base;
  for (const part of cwd === '.' ? [] : cwd.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part)) throw new Error('命令目录无效');
    path = join(path, part); const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('命令目录不能包含链接');
    const rel = relative(base, realpathSync(path)); if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('命令目录越界');
  }
  if (/[",\r\n]/.test(path)) throw new Error('挂载目录包含不支持的字符');
  return path;
}
export function createArguments(config: ExecutorConfig, request: CommandRequest): string[] {
  const directory = commandDirectory(config.workspacePath, request.cwd);
  return ['create', '--pull', 'never', '--name', containerName(request.id), '--label', 'vip.mengluo.mlclaw=executor',
    '--network', 'none', '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--ulimit', 'nofile=64:64',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--mount', `type=bind,source=${directory},target=/workspace`,
    '--workdir', '/workspace', '--stop-timeout', '1', '--entrypoint', '/usr/bin/timeout', config.image,
    '-s', 'KILL', `${request.timeoutMs / 1000}`, '/bin/sh', '-c', request.command, 'mlclaw', ...request.args];
}

// 只执行固定 docker 子命令；用户的脚本文本只能作为容器内 sh -c 的参数。
function docker(args: string[], signal?: AbortSignal, outputLimit = 65536): Promise<{ code: number; stdout: string; stderr: string; overflow: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let size = 0; let overflow = false;
    const kill = () => { child.kill('SIGKILL'); }; const timeout = setTimeout(kill, 15000);
    signal?.addEventListener('abort', kill, { once: true }); if (signal?.aborted) kill();
    const capture = (parts: Buffer[]) => (chunk: Buffer) => {
      const available = Math.max(0, outputLimit - size); if (available) parts.push(chunk.subarray(0, available)); size += chunk.length;
      if (size > outputLimit) { overflow = true; kill(); }
    };
    child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
    const clean = () => { clearTimeout(timeout); signal?.removeEventListener('abort', kill); };
    child.once('error', () => { clean(); reject(new Error('Docker 不可用')); });
    child.once('close', code => { clean(); resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), overflow }); });
  });
}
export class DockerRunner implements Runner {
  constructor(private config: ExecutorConfig) {}
  async cleanup(id: string) {
    const name = containerName(id);
    await docker(['rm', '--force', name]);
    const inspect = await docker(['container', 'inspect', name]);
    if (inspect.code === 0 || !inspect.stderr.includes('No such')) throw new Error('无法确认执行容器已清理');
  }
  async execute(request: CommandRequest, signal: AbortSignal): Promise<CommandResult> {
    const started = Date.now(); const timeout = AbortSignal.timeout(request.timeoutMs + 3000);
    const combined = AbortSignal.any([signal, timeout]);
    let result: CommandResult; let creationUncertain = false;
    try {
      combined.throwIfAborted();
      const create = await docker(createArguments(this.config, request), undefined, 4096);
      creationUncertain = create.code < 0;
      if (create.code !== 0) throw new Error('容器创建失败');
      combined.throwIfAborted();
      const run = await docker(['start', '--attach', containerName(request.id)], combined);
      result = { status: signal.aborted ? 'cancelled' : timeout.aborted || run.overflow || run.code !== 0 ? 'failed' : 'succeeded', stdout: run.stdout, stderr: run.stderr, exitCode: run.code < 0 ? null : run.code, durationMs: Date.now() - started,
        ...(run.overflow ? { reason: '命令输出超过 64 KiB 上限' } : timeout.aborted ? { reason: '命令超时' } : {}) };
    } catch { result = { status: signal.aborted ? 'cancelled' : 'failed', stdout: '', stderr: '', exitCode: null, durationMs: Date.now() - started, reason: combined.aborted ? '命令取消或超时' : '容器启动失败，请检查执行服务配置' }; }
    // create 与 start 顺序等待，清理在两者结束后执行，避免取消后晚创建容器。
    await this.cleanup(request.id);
    if (creationUncertain) throw new Error('容器创建应答未确认，执行服务需恢复检查');
    return result;
  }
}
