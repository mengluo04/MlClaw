import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CommandRequest, CommandResult } from '@mlclaw/shared';
import { ToolError, Workspace } from './files.js';
import { resolveCommand } from './command.js';

// 主容器内的可信脚本执行器；cwd 校验不限制脚本自身的文件/网络权限。
export class ScriptExecutor {
  /** 进程清理是否无法确认；为真时禁止启动新脚本。 */
  uncertain = false;
  /** 尚未完成清理的脚本请求标识集合。 */
  private active = new Set<string>();
  constructor(private workspace: Workspace) {}
  /** 通过进程监督器执行可信脚本，限制超时、并发和输出并收集结果。 */
  async execute(request: CommandRequest, signal: AbortSignal): Promise<CommandResult> {
    signal.throwIfAborted();
    if (this.uncertain || this.active.size) throw new ToolError('已有脚本运行或清理未完成');
    if (
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 100 ||
      request.timeoutMs > 300000
    )
      throw new ToolError('脚本超时需在 100–300000 毫秒之间');
    /** 解析后的可执行文件、参数及工作目录。 */
    const command = resolveCommand(this.workspace, request.command, request.cwd, request.args);
    this.active.add(request.id);
    /** 脚本开始执行的毫秒时间戳。 */
    const started = Date.now();
    try {
      return await new Promise<CommandResult>((resolve, reject) => {
        /** 构建后进程监督器模块的地址。 */
        const built = new URL('./process-supervisor.js', import.meta.url);
        /** 按构建状态选择的进程监督器入口。 */
        const helper = existsSync(built)
          ? built
          : new URL('./process-supervisor.ts', import.meta.url);
        /** 本次启动的子进程。 */
        const child = spawn(process.execPath, [fileURLToPath(helper)], {
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        /** 已收集的标准输出；已收集的标准错误输出。 */
        const stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        /** 当前数据大小；输出是否已经超过容量上限；是否因超时结束；是否正在停止。 */
        let size = 0,
          overflow = false,
          timedOut = false,
          stopping = false;
        /** 子进程退出码。 */
        let exitCode: number | null = null;
        /** 是否收到子进程上报的退出结果。 */
        let reported = false;
        /** 延迟清理资源的定时器。 */
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        /** 停止当前执行或后台资源。 */
        const stop = () => {
          if (stopping) return;
          stopping = true;
          if (child.pid) {
            if (process.platform === 'win32') {
              /** 用于终止 Windows 进程树的 taskkill 子进程。 */
              const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
              });
              kill.once('error', () => {
                this.uncertain = true;
                child.kill();
              });
            } else {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
                  this.uncertain = true;
              }
            }
          }
          cleanupTimer = setTimeout(() => {
            this.uncertain = true;
            clean();
            reject(new ToolError('无法确认脚本已停止，已禁止新任务；请重启容器'));
          }, 5000);
        };
        /** 触发脚本超时终止的定时器。 */
        const timeout = setTimeout(() => {
          timedOut = true;
          stop();
        }, request.timeoutMs);
        /** 中止当前执行并通知取消信号的订阅者。 */
        const abort = () => stop();
        /** 清除执行与清理定时器，并解除取消事件监听。 */
        const clean = () => {
          clearTimeout(timeout);
          clearTimeout(cleanupTimer);
          signal.removeEventListener('abort', abort);
        };
        /** 按共享 64 KiB 配额收集输出，超限时终止进程。 */
        const capture = (parts: Buffer[]) => (chunk: Buffer) => {
          /** 标准输出与标准错误共用的剩余字节配额。 */
          const available = Math.max(0, 65536 - size);
          if (available) parts.push(chunk.subarray(0, available));
          size += chunk.length;
          if (size > 65536) {
            overflow = true;
            stop();
          }
        };
        child.stdout!.on('data', capture(stdout));
        child.stderr!.on('data', capture(stderr));
        child.once('spawn', () => {
          if (signal.aborted || stopping) {
            stop();
            return;
          }
          child.send({ ...command, timeoutMs: request.timeoutMs }, (error) => {
            if (error) stop();
          });
        });
        child.on('message', (message: unknown) => {
          if (message && typeof message === 'object' && 'exitCode' in message) {
            reported = true;
            exitCode = typeof message.exitCode === 'number' ? message.exitCode : null;
            stop();
          }
        });
        child.once('error', () => {
          clean();
          reject(new ToolError('脚本执行进程启动失败'));
        });
        child.once('close', () => {
          clean();
          resolve({
            status: signal.aborted
              ? 'cancelled'
              : !reported || overflow || timedOut || exitCode !== 0
                ? 'failed'
                : 'succeeded',
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode,
            durationMs: Date.now() - started,
            ...(overflow
              ? { reason: '脚本输出超过 64 KiB 上限' }
              : timedOut
                ? { reason: '脚本执行超时' }
                : signal.aborted
                  ? { reason: '脚本已取消' }
                  : !reported || exitCode === null
                    ? { reason: '脚本启动失败或运行进程意外退出，请检查解释器和脚本' }
                    : {}),
          });
        });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) stop();
      });
    } finally {
      this.active.delete(request.id);
    }
  }
}
