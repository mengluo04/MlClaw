import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createExecutor } from '../../executor/src/app.js';
import { createArguments, type ExecutorConfig, type Runner } from '../../executor/src/runner.js';
import { ExecutorClient } from '../src/tools/executor.js';
import type { CommandRequest, CommandResult } from '@mlclaw/shared';
import { waitFor } from './helpers.js';

const token = 'test-executor-token-not-a-real-secret-1234';
const success: CommandResult = { status: 'succeeded', stdout: '模拟命令输出', stderr: '', exitCode: 0, durationMs: 1 };
const request = (): CommandRequest => ({ id: randomUUID(), command: 'printf "%s" "$1"', args: ['a; rm -rf /'], cwd: '.', timeoutMs: 1000 });
function directory() { mkdirSync(resolve('data'), { recursive: true }); return mkdtempSync(resolve('data/executor-')); }
function config(root: string): ExecutorConfig { return { workspacePath: root, databasePath: join(root, 'jobs.sqlite'), token, image: 'alpine:3.22', host: '127.0.0.1', port: 3001 }; }
function cleanup(path: string) { assert.ok(path.startsWith(resolve('data'))); rmSync(path, { recursive: true }); }

test('容器策略固定，模型无法修改资源、挂载、镜像或宿主 shell', () => {
  const root = directory();
  try {
    const job = request(); const args = createArguments(config(root), job);
    assert.equal(args[0], 'create'); assert.ok(args.includes('none')); assert.ok(args.includes('65532:65532')); assert.ok(args.includes('--read-only')); assert.ok(args.includes('no-new-privileges')); assert.ok(args.includes('--pids-limit')); assert.ok(args.includes('--memory')); assert.ok(args.includes('--cpus'));
    assert.deepEqual(args.slice(-4), ['-c', job.command, 'mlclaw', job.args[0]]);
    assert.equal(args.filter(arg => arg === '--mount').length, 1); assert.ok(!args.join(' ').includes('docker.sock')); assert.ok(!args.includes('--privileged')); assert.ok(!args.includes('-e'));
    for (const cwd of ['../', 'C:/Windows', 'x,source=/etc', '/etc']) assert.throws(() => createArguments(config(root), { ...job, cwd }));
    symlinkSync(resolve('data'), join(root, 'link'), 'junction'); assert.throws(() => createArguments(config(root), { ...job, cwd: 'link' }));
  } finally { cleanup(root); }
});

test('执行服务认证、参数绑定、单任务与持久化防重放', async () => {
  const root = directory(); let count = 0;
  const runner: Runner = { async execute() { count++; return success; }, async cleanup() {} };
  let instance = await createExecutor(config(root), runner); const headers = { authorization: `Bearer ${token}` }; const job = request();
  try {
    assert.equal((await instance.app.inject('/health')).statusCode, 401);
    assert.equal((await instance.app.inject({ method: 'POST', url: '/jobs', headers, payload: { ...job, image: 'evil' } })).statusCode, 400);
    assert.equal((await instance.app.inject({ method: 'POST', url: '/jobs', headers, payload: job })).statusCode, 202);
    await waitFor(() => count === 1);
    assert.equal((await instance.app.inject({ method: 'POST', url: '/jobs', headers, payload: job })).statusCode, 200);
    assert.equal((await instance.app.inject({ method: 'POST', url: '/jobs', headers, payload: { ...job, command: 'changed' } })).statusCode, 409);
    await instance.app.close(); instance = await createExecutor(config(root), runner);
    assert.equal((await instance.app.inject({ method: 'POST', url: '/jobs', headers, payload: job })).json().status, 'succeeded'); assert.equal(count, 1);
    const cancelled = request(); await instance.app.inject({ method: 'POST', url: `/jobs/${cancelled.id}/cancel`, headers });
    assert.equal((await instance.app.inject({ method: 'POST', url: '/jobs', headers, payload: cancelled })).statusCode, 409);
  } finally { await instance.app.close(); cleanup(root); }
});

test('执行客户端取消等待清理，未确认清理时禁止继续执行', async () => {
  const root = directory(); let cleaned = false; let running = false;
  const runner: Runner = { async execute(_, signal) { running = true; await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); }); await new Promise(resolve => setTimeout(resolve, 30)); cleaned = true; return { ...success, status: 'cancelled' }; }, async cleanup() {} };
  const instance = await createExecutor(config(root), runner);
  try {
    const address = await instance.app.listen({ port: 0, host: '127.0.0.1' });
    const client = new ExecutorClient(address, token); const controller = new AbortController();
    const result = client.execute(request(), controller.signal);
    await waitFor(() => running); controller.abort(); await assert.rejects(result);
    assert.equal(cleaned, true); assert.equal(client.uncertain, false);
    await instance.app.close(); await assert.rejects(client.cancel(randomUUID())); assert.equal(client.uncertain, true);
  } finally { await instance.app.close(); cleanup(root); }
});

test('执行服务重启清理遗留容器，清理失败不开放新任务', async () => {
  const root = directory(); let cleans = 0;
  const runner: Runner = { async execute() { throw new Error('模拟清理失败'); }, async cleanup() { cleans++; throw new Error('仍未确认'); } };
  let instance = await createExecutor(config(root), runner); const headers = { authorization: `Bearer ${token}` };
  try {
    const job = request(); await instance.app.inject({ method: 'POST', url: '/jobs', headers, payload: job });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await instance.app.inject({ url: '/health', headers })).statusCode, 503);
    await instance.app.close(); instance = await createExecutor(config(root), runner);
    assert.equal(cleans, 1); assert.equal((await instance.app.inject({ method: 'POST', url: '/jobs', headers, payload: request() })).statusCode, 503);
  } finally { await instance.app.close(); cleanup(root); }
});
