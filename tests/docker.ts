import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DockerRunner, type ExecutorConfig } from '../apps/executor/src/runner.js';

const available = spawnSync('docker', ['info'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
if (available.status !== 0) throw new Error('需要已运行的 Docker Linux 容器引擎；本次未执行真实容器验证');
const image = process.env.EXECUTOR_IMAGE;
if (!image) throw new Error('请设置已预先获取并审核的 EXECUTOR_IMAGE（需要 /bin/sh 和 /usr/bin/timeout）');
mkdirSync(resolve('data'), { recursive: true }); const root = mkdtempSync(resolve('data/docker-check-')); chmodSync(root, 0o777);
const config: ExecutorConfig = { workspacePath: root, databasePath: ':memory:', token: 'test-only-token-not-used-in-container', image, host: '127.0.0.1', port: 3001 };
const runner = new DockerRunner(config);
const run = (command: string, timeoutMs = 2000, signal = new AbortController().signal) => runner.execute({ id: randomUUID(), command, cwd: '.', args: [], timeoutMs }, signal);
try {
  const identity = await run('id -u; test ! -e /var/run/docker.sock; test -z "$EXECUTOR_TOKEN"; test -z "$ADMIN_PASSWORD"; echo safe > result.txt');
  assert.equal(identity.status, 'succeeded'); assert.match(identity.stdout, /65532/); assert.equal(readFileSync(join(root, 'result.txt'), 'utf8').trim(), 'safe');
  const readonly = await run('touch /forbidden'); assert.equal(readonly.status, 'failed');
  const timeout = await run('sleep 30', 500); assert.equal(timeout.status, 'failed');
  const output = await run('while :; do printf "abcdefghijklmnopqrstuvwxyz0123456789"; done'); assert.equal(output.status, 'failed'); assert.ok(Buffer.byteLength(output.stdout) <= 65536);
  const controller = new AbortController(); const cancel = run('sleep 30 & wait', 8000, controller.signal); setTimeout(() => controller.abort(), 300); assert.equal((await cancel).status, 'cancelled');
  const remaining = spawnSync('docker', ['ps', '-aq', '--filter', 'label=vip.mengluo.mlclaw=executor'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(remaining.status, 0); assert.equal(remaining.stdout.trim(), '');
  console.log('真实 Docker 验证通过：非 root、密钥隔离、只读根、输出上限、超时、取消与容器清理；CPU/内存/PID/网络策略仍需目标部署环境验证。');
} finally { assert.ok(root.startsWith(resolve('data'))); rmSync(root, { recursive: true }); }
