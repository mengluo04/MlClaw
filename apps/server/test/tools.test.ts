import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { Workspace } from '../src/tools/files.js';
import type { ModelEvent, Provider, ToolCall } from '../src/providers/types.js';
import { fixture, waitFor } from './helpers.js';
import { runAgent } from '../src/agent/loop.js';

function directory() { const root = resolve('data'); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, 'tools-')); }
function cleanup(path: string) { assert.ok(path.startsWith(resolve('data') + '\\') || path.startsWith(resolve('data') + '/')); rmSync(path, { recursive: true }); }
const call = (name: string, args: unknown): ToolCall => ({ id: 'model-call', type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('路径越界、Windows ADS、目录联接、硬链接及文件限制', () => {
  const root = directory(); const inside = join(root, 'inside'); const outside = join(root, 'outside'); mkdirSync(outside);
  const workspace = new Workspace(inside); const signal = new AbortController().signal;
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(inside, 'link'), 'junction');
    linkSync(join(outside, 'secret.txt'), join(inside, 'hard.txt'));
    for (const path of ['../outside/secret.txt', '/etc/passwd', 'C:/Windows/a', 'file:stream', 'a\\b', 'a/../b', 'con', 'x. ', 'link/secret.txt', 'hard.txt']) assert.throws(() => workspace.read(path), undefined, path);
    workspace.write('test.txt', '原文本较长', 'absent', signal);
    const snapshot = workspace.snapshot('test.txt'); workspace.write('test.txt', '短', snapshot, signal); assert.equal(workspace.read('test.txt'), '短');
    assert.throws(() => workspace.write('test.txt', 'oops', snapshot, signal), /变化/);
    assert.throws(() => workspace.write('huge.txt', '中'.repeat(30000), 'absent', signal), /64 KiB/);
    writeFileSync(join(inside, 'binary.txt'), Buffer.from([0xff])); assert.throws(() => workspace.read('binary.txt'), /UTF-8/);
    assert.equal(workspace.search('.', '短', signal).results[0]!.path, 'test.txt');
    assert.ok(workspace.list('.').entries.some(entry => entry.name === 'link' && entry.type === 'blocked-link'));
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret');
  } finally { cleanup(root); }
});

test('工具注册校验未知名称、非法参数和默认覆盖授权', async () => {
  const root = directory(); const registry = new ToolRegistry(root);
  try {
    for (const item of [call('unknown', {}), call('write_text', { path: 'a', content: 5 }), call('read_text', { path: 'a', extra: true })]) assert.throws(() => registry.prepare(item));
    const first = registry.prepare(call('write_text', { path: 'a', content: 'data' })); assert.equal(first.approval, false);
    await registry.execute(first, new AbortController().signal);
    const overwrite = registry.prepare(call('write_text', { path: 'a', content: 'other' })); assert.equal(overwrite.approval, true); assert.notEqual(overwrite.digest, first.digest);
    const controller = new AbortController(); controller.abort(); await assert.rejects(registry.execute(overwrite, controller.signal)); assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'data');
  } finally { cleanup(root); }
});

test('智能体创建并读取文件，工具结果回传且记录状态', async () => {
  const root = directory(); let round = 0;
  const provider: Provider = { async *stream(messages): AsyncGenerator<ModelEvent> {
    if (round++ === 0) yield { type: 'complete', calls: [call('write_text', { path: 'created.txt', content: '自然语言任务测试' })] };
    else if (round === 2) { assert.equal(messages.at(-1)!.role, 'tool'); yield { type: 'complete', calls: [call('read_text', { path: 'created.txt' })] }; }
    else { assert.ok(messages.at(-1)!.content.includes('自然语言任务测试')); yield { type: 'delta', text: '已创建并读取' }; yield { type: 'complete', calls: [] }; }
  } };
  const f = await fixture(provider, root);
  try {
    const id = (await f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers, payload: { content: '创建并读取文件', idempotencyKey: 'create' } })).json().taskId;
    await waitFor(() => !f.tasks.isActive(id));
    const task = (await f.app.inject({ url: `/api/tasks/${id}`, headers: f.headers })).json(); assert.equal(task.status, 'succeeded'); assert.equal(task.tools.length, 2); assert.ok(task.tools.every((tool: { status: string }) => tool.status === 'succeeded'));
    assert.equal(readFileSync(join(root, 'created.txt'), 'utf8'), '自然语言任务测试');
  } finally { await f.app.close(); cleanup(root); }
});

for (const decision of ['deny', 'approve', 'changed', 'cancel'] as const) test(`覆盖确认绑定参数与文件快照：${decision}`, async () => {
  const root = directory(); writeFileSync(join(root, 'file.txt'), 'original'); let round = 0;
  const provider: Provider = { async *stream(): AsyncGenerator<ModelEvent> { if (round++ === 0) yield { type: 'complete', calls: [call('write_text', { path: 'file.txt', content: 'approved' })] }; else { yield { type: 'delta', text: '结束' }; yield { type: 'complete', calls: [] }; } } };
  const f = await fixture(provider, root);
  try {
    const id = (await f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers, payload: { content: '覆盖文件', idempotencyKey: decision } })).json().taskId;
    await waitFor(() => f.db.prepare('SELECT status FROM tasks WHERE id=?').get(id)!.status === 'waiting_approval');
    const tool = f.db.prepare('SELECT * FROM tool_calls WHERE task_id=?').get(id)!;
    const decide = (digest: string, approved: boolean) => f.app.inject({ method: 'POST', url: `/api/tool-calls/${tool.id}/decision`, headers: f.headers, payload: { argumentsDigest: digest, approved } });
    assert.equal((await decide('0'.repeat(64), true)).statusCode, 409);
    if (decision === 'changed') writeFileSync(join(root, 'file.txt'), 'external-change');
    if (decision === 'cancel') { await f.app.inject({ method: 'POST', url: `/api/tasks/${id}/cancel`, headers: f.headers }); assert.equal((await decide(String(tool.arguments_digest), true)).statusCode, 409); }
    else assert.equal((await decide(String(tool.arguments_digest), decision !== 'deny')).statusCode, 200);
    await waitFor(() => !f.tasks.isActive(id));
    assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), decision === 'approve' ? 'approved' : decision === 'changed' ? 'external-change' : 'original');
    const stored = f.db.prepare('SELECT status FROM tool_calls WHERE id=?').get(String(tool.id))!;
    assert.equal(stored.status, decision === 'approve' ? 'succeeded' : decision === 'deny' ? 'denied' : decision === 'changed' ? 'failed' : 'interrupted');
  } finally { await f.app.close(); cleanup(root); }
});

test('智能体达到轮数上限终止，授权等待受总时限约束', async () => {
  const root = directory();
  const provider: Provider = { async *stream(): AsyncGenerator<ModelEvent> { yield { type: 'complete', calls: [call('list_directory', { path: '.' })] }; } };
  const f = await fixture(provider, root);
  try {
    const id = (await f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers, payload: { content: '循环', idempotencyKey: 'loop' } })).json().taskId;
    await waitFor(() => !f.tasks.isActive(id)); assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(id)!.status, 'failed'); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE task_id=?').get(id)!.n, 8);
    writeFileSync(join(root, 'wait.txt'), 'original');
    const prepared = f.tasks.registry.prepare(call('write_text', { path: 'wait.txt', content: 'no' }));
    const keepAlive = setTimeout(() => {}, 100);
    try { await assert.rejects(f.tasks.approvals.wait(prepared, AbortSignal.timeout(20))); } finally { clearTimeout(keepAlive); }
    assert.equal(readFileSync(join(root, 'wait.txt'), 'utf8'), 'original');
  } finally { await f.app.close(); cleanup(root); }
});
