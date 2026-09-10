import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fixture, waitFor } from './helpers.js';
import { memoryContext } from '../src/memory/index.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import type { Provider, ModelEvent } from '../src/providers/types.js';

function directory() { mkdirSync(resolve('data'), { recursive: true }); return mkdtempSync(resolve('data/workspace-')); }
function cleanup(root: string) { assert.ok(root.startsWith(resolve('data'))); rmSync(root, { recursive: true }); }

test('文件上传下载、编码、路径、大小、配额与覆盖拒绝', async () => {
  const root = directory(); const f = await fixture(undefined, root);
  try {
    const upload = (path: string, text: string) => f.app.inject({ method: 'POST', url: '/api/files/upload', headers: f.headers, payload: { path, contentBase64: Buffer.from(text).toString('base64') } });
    assert.equal((await upload('上传.txt', '工具可读取')).statusCode, 200);
    assert.equal(f.tasks.registry.workspace.read('上传.txt'), '工具可读取');
    const response = await f.app.inject({ url: '/api/files/download?path=' + encodeURIComponent('上传.txt'), headers: f.headers }); assert.equal(response.body, '工具可读取'); assert.match(String(response.headers['content-disposition']), /^attachment/);
    assert.equal((await upload('上传.txt', '覆盖')).statusCode, 409); assert.equal(readFileSync(join(root, '上传.txt'), 'utf8'), '工具可读取');
    assert.equal((await upload('../outside.txt', 'bad')).statusCode, 400);
    assert.equal((await upload('big.txt', 'x'.repeat(65537))).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/files/upload', headers: f.headers, payload: { path: 'bad.txt', contentBase64: 'not-base64' } })).statusCode, 400);
    assert.equal((await f.app.inject('/api/files')).statusCode, 401);
    for (let i = 0; i < 500; i++) writeFileSync(join(root, `${i}.txt`), '');
    assert.equal((await upload('quota.txt', 'no')).statusCode, 400);
    assert.equal((await f.app.inject({ url: '/api/files', headers: f.headers })).json().truncated, true);
  } finally { await f.app.close(); cleanup(root); }
});

test('显式记忆增删改、容量与优先级，以及新任务上下文', async () => {
  const contexts: string[] = [];
  const provider: Provider = { async *stream(messages): AsyncGenerator<ModelEvent> { contexts.push(JSON.stringify(messages)); yield { type: 'complete', calls: [] }; } };
  const root = directory(); const f = await fixture(provider, root);
  try {
    const create = (content: string, priority: number) => f.app.inject({ method: 'POST', url: '/api/memories', headers: f.headers, payload: { content, priority } });
    const memory = (await create('用户喜欢中文', 5)).json(); assert.ok(memory.id);
    await create('低优先级内容', -5);
    const userId = String(f.db.prepare('SELECT id FROM users').get()!.id);
    assert.ok(memoryContext(f.db, userId).indexOf('用户喜欢中文') < memoryContext(f.db, userId).indexOf('低优先级内容'));
    const submit = async (key: string) => { const id = (await f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers, payload: { content: '你好', idempotencyKey: key } })).json().taskId; await waitFor(() => !f.tasks.isActive(id)); };
    await submit('before'); assert.ok(contexts[0]!.includes('用户喜欢中文'));
    assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/memories/${memory.id}`, headers: f.headers, payload: { content: '偏好简洁', priority: 10 } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/memories/${memory.id}`, headers: f.headers })).statusCode, 200);
    await submit('after'); assert.ok(!contexts[1]!.includes('用户喜欢中文')); assert.ok(!contexts[1]!.includes('偏好简洁'));
    for (let i = 0; i < 3; i++) await create(String(i).repeat(2000), i);
    assert.ok(memoryContext(f.db, userId).length < 6300);
    assert.equal((await create('x'.repeat(2001), 0)).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'DELETE', url: '/api/memories/unknown', headers: f.headers })).statusCode, 404);
    assert.equal((await f.app.inject({ url: '/api/tasks', headers: f.headers })).json().length, 2);
  } finally { await f.app.close(); cleanup(root); }
});

test('重启把遗留任务和工具标为中断，幂等请求不重复副作用', async () => {
  const root = directory(); const file = join(root, 'state.sqlite'); let calls = 0;
  const config = { host: '127.0.0.1', port: 3000, databasePath: file, origin: 'http://127.0.0.1:5173', secureCookie: false, adminUsername: 'admin', adminPassword: 'restart-test-only-123', sessionSeconds: 86400, workspacePath: join(root, 'files') };
  const provider: Provider = { async *stream(): AsyncGenerator<ModelEvent> { calls++; if (calls === 1) yield { type: 'complete', calls: [{ id: 'write-once', type: 'function', function: { name: 'write_text', arguments: '{"path":"once.txt","content":"once"}' } }] }; else yield { type: 'complete', calls: [] }; } };
  let instance = await createApp(config, false, () => provider);
  try {
    const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.origin }, payload: { username: 'admin', password: config.adminPassword } });
    const headers = { origin: config.origin, cookie: String(login.headers['set-cookie']).split(';')[0]! };
    const conversationId = (await instance.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: { title: '恢复' } })).json().id;
    const payload = { content: '写入一次', idempotencyKey: 'once' }; const url = `/api/conversations/${conversationId}/messages`;
    const id = (await instance.app.inject({ method: 'POST', url, headers, payload })).json().taskId; await waitFor(() => !instance.tasks.isActive(id));
    const before = calls; await instance.app.close();
    const db = openDatabase(file); db.prepare("UPDATE tasks SET status='running',finished_at=NULL WHERE id=?").run(id); db.prepare("UPDATE tool_calls SET status='running',finished_at=NULL WHERE task_id=?").run(id); db.close();
    instance = await createApp({ ...config, adminPassword: undefined }, false, () => provider);
    const result = (await instance.app.inject({ url: `/api/tasks/${id}`, headers })).json(); assert.equal(result.status, 'interrupted'); assert.equal(result.tools[0].status, 'interrupted');
    assert.equal((await instance.app.inject({ method: 'POST', url, headers, payload })).json().taskId, id); assert.equal(calls, before); assert.equal(readFileSync(join(config.workspacePath, 'once.txt'), 'utf8'), 'once');
    const events = await instance.app.inject({ url: `/api/tasks/${id}/events`, headers }); assert.ok(events.body.includes('interrupted'));
  } finally { await instance.app.close(); cleanup(root); }
});

test('真实 HTTP SSE 断线补发不重复调用，登录过期关闭订阅', async () => {
  let release: (() => void) | undefined; let calls = 0;
  const provider: Provider = { async *stream(): AsyncGenerator<ModelEvent> { calls++; yield { type: 'delta', text: '第一段' }; await new Promise<void>(resolve => { release = resolve; }); yield { type: 'delta', text: '第二段' }; yield { type: 'complete', calls: [] }; } };
  const root = directory(); const f = await fixture(provider, root);
  try {
    const base = await f.app.listen({ port: 0, host: '127.0.0.1' });
    const id = (await f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers, payload: { content: '流', idempotencyKey: 'stream' } })).json().taskId;
    await waitFor(() => !!release);
    const controller = new AbortController(); const response = await fetch(`${base}/api/tasks/${id}/events`, { headers: f.headers, signal: controller.signal }); const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value); assert.ok(first.includes('第一段')); controller.abort(); await reader.cancel().catch(() => {});
    const replay = await fetch(`${base}/api/tasks/${id}/events`, { headers: { ...f.headers, 'last-event-id': '2' }, signal: AbortSignal.timeout(3000) });
    release!(); const text = await replay.text(); assert.ok(text.includes('第一段')); assert.ok(text.includes('第二段')); assert.ok(!text.includes('id: 1\n')); assert.equal(calls, 1);
    const second = (await f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers, payload: { content: '过期', idempotencyKey: 'expire' } })).json().taskId;
    await waitFor(() => f.tasks.isActive(second));
    const expiry = await fetch(`${base}/api/tasks/${second}/events`, { headers: f.headers, signal: AbortSignal.timeout(3000) });
    f.db.prepare('UPDATE sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z'); await expiry.text();
    assert.equal((await fetch(`${base}/api/tasks/${second}/events`, { headers: f.headers })).status, 401);
  } finally { release?.(); await f.app.close(); cleanup(root); }
});
