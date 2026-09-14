import { spawn } from 'node:child_process';

// 主服务退出后 IPC 断开；Linux 上终止整个独立进程组，避免普通子进程遗留。
const stop = () => {
  if (process.platform === 'win32') {
    /** 用于终止 Windows 进程树的 taskkill 子进程。 */
    const kill = spawn('taskkill', ['/PID', String(process.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    kill.once('error', () => process.exit(1));
  } else process.kill(-process.pid, 'SIGKILL');
};
process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
/** 等待启动消息的超时定时器。 */
const startup = setTimeout(stop, 10000);
process.once(
  'message',
  (input: { executable: string; args: string[]; directory: string; timeoutMs: number }) => {
    clearTimeout(startup);
    setTimeout(stop, input.timeoutMs + 1000);
    /** 本次启动的子进程。 */
    const child = spawn(input.executable, input.args, {
      cwd: input.directory,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', () => process.send?.({ exitCode: null }));
    child.once('exit', (code) => process.send?.({ exitCode: code }));
  },
);
