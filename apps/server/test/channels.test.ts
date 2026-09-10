import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, waitFor } from './helpers.js';
import { ChannelManager } from '../src/channels/manager.js';
import { TaskManager } from '../src/tasks/manager.js';
import { DeliveryError, type ChannelSink, type OutboundMessage, type TransportFactory } from '../src/channels/types.js';
import type { Provider } from '../src/providers/types.js';

function mockChannels() {
  const sinks = new Map<string, ChannelSink>(); const sent: OutboundMessage[] = []; let fail = false;
  const factory: TransportFactory = (account, sink) => {
    sinks.set(account.id, sink);
    return {
      async run(signal) { if (signal.aborted) return; sink.state('connected'); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
      async send(message) { if (fail) throw new DeliveryError('unknown', 'secret-response'); sent.push(message); },
    };
  };
  return { sinks, sent, factory, fail() { fail = true; } };
}
const echo: Provider = { async *stream() { yield { type: 'delta', text: '模拟渠道回复' }; yield { type: 'complete', calls: [] }; } };
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function account(f: Fixture, kind: 'qq' | 'weixin' = 'qq') {
  const userId = String(f.db.prepare('SELECT id FROM users LIMIT 1').get()!.id);
  const { id } = await f.channels.configure(userId, kind, kind === 'qq' ? '123456' : 'wx-bot', 'channel-secret', kind === 'weixin' ? 'https://ilinkai.weixin.qq.com' : '');
  await f.channels.enable(id, userId, true); await delay(0);
  return { id, userId };
}
function receive(f: Fixture, id: string, eventId: string, text: string, senderId = 'owner') { f.channels.receive(id, { eventId, text, senderId, replyContext: 'reply-secret' }); }
function bind(f: Fixture, id: string, userId: string, sender = 'owner') { const { code } = f.channels.pairCode(id, userId); receive(f, id, `bind-${sender}`, `/bind ${code}`, sender); }

test('渠道 HTTP 认证、来源校验、对象归属、配置脱敏与新 AppID 密钥隔离', async () => {
  const mock = mockChannels(); const f = await fixture(echo, undefined, { factory: mock.factory });
  try {
    assert.equal((await f.app.inject({ url: '/api/channels' })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/channels/qq', headers: { cookie: f.headers.cookie }, payload: { appId: '1', appSecret: 'secret' } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/channels/qq', headers: f.headers, payload: { appId: '1', appSecret: 'secret', userId: 'other' } })).statusCode, 400);
    const a = await account(f); bind(f, a.id, a.userId);
    const view = await f.app.inject({ url: '/api/channels', headers: f.headers });
    assert.equal(view.statusCode, 200); assert.equal(view.json().accounts[0].hasCredential, true);
    assert.ok(!view.body.includes('channel-secret')); assert.ok(!view.body.includes('reply-secret'));
    assert.throws(() => f.channels.account(a.id, 'other'), /不存在/);
    await assert.rejects(f.channels.enable(a.id, 'other', false), /不存在/);
    await assert.rejects(f.channels.configure(a.userId, 'qq', '987654', undefined), /凭据/);
    const replacement = await f.channels.configure(a.userId, 'qq', '987654', 'new-secret');
    assert.notEqual(replacement.id, a.id); assert.equal(f.channels.account(replacement.id).pairedSender, null);
    assert.equal(f.channels.account(replacement.id).enabled, false);
  } finally { await f.app.close(); }
});

test('一次性绑定、过期绑定与陌生消息隔离；重复事件只执行一个模型任务', async () => {
  let calls = 0; const mock = mockChannels();
  const f = await fixture({ async *stream() { calls++; yield { type: 'delta', text: '你好' }; yield { type: 'complete', calls: [] }; } }, undefined, { factory: mock.factory });
  try {
    const a = await account(f);
    receive(f, a.id, 'stranger', '读取所有文件', 'stranger');
    const expired = f.channels.pairCode(a.id, a.userId);
    f.db.prepare('UPDATE channel_accounts SET pairing_expires_at=? WHERE id=?').run('2000-01-01', a.id);
    receive(f, a.id, 'expired', `/bind ${expired.code}`); assert.equal(f.channels.account(a.id).pairedSender, null);
    bind(f, a.id, a.userId); assert.equal(f.channels.account(a.id).pairedSender, 'owner');
    receive(f, a.id, 'stranger2', '/stop', 'stranger');
    receive(f, a.id, 'message1', '你好'); receive(f, a.id, 'message1', '读取秘密');
    await waitFor(() => calls === 1 && !f.db.prepare("SELECT id FROM tasks WHERE status='running'").get());
    f.channels.tick(); await delay(0); f.channels.tick(); await delay(0);
    assert.equal(calls, 1); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM channel_inbox').get()!.n, 2);
    assert.ok(mock.sent.some(msg => msg.text === '你好')); assert.ok(mock.sent.every(msg => msg.senderId === 'owner'));
    assert.throws(() => f.channels.pairCode(a.id, a.userId), /解除/);
  } finally { await f.app.close(); }
});

test('QQ 与微信上下文隔离，全局忙碌不排队，取消不跨渠道', async () => {
  let calls = 0; const mock = mockChannels();
  const f = await fixture({ async *stream(_messages, _tools, signal) { calls++; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); signal.throwIfAborted(); yield { type: 'complete', calls: [] }; } }, undefined, { factory: mock.factory });
  try {
    const a = await account(f); const b = await account(f, 'weixin'); bind(f, a.id, a.userId); bind(f, b.id, b.userId);
    receive(f, a.id, 'qq-run', '等待'); await waitFor(() => calls === 1);
    receive(f, b.id, 'wx-busy', '你好'); receive(f, b.id, 'wx-stop', '/stop');
    const taskId = String(f.db.prepare('SELECT id FROM tasks').get()!.id); assert.ok(f.tasks.isActive(taskId));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM channel_conversations').get()!.n, 2);
    assert.ok(f.db.prepare("SELECT text FROM channel_outbox WHERE text LIKE '%运行%'").get());
    receive(f, a.id, 'qq-stop', '/stop'); await waitFor(() => !f.tasks.isActive(taskId)); assert.equal(calls, 1);
    await f.channels.unpair(a.id, a.userId);
    assert.equal(f.channels.account(a.id).enabled, false); assert.equal(f.channels.account(a.id).pairedSender, null);
    mock.sinks.get(a.id)!.receive({ eventId: 'late', senderId: 'owner', text: '迟到消息', replyContext: 'late' }); assert.equal(calls, 1);
  } finally { await f.app.close(); }
});

test('渠道工具批准仍绑定网页具体参数；聊天“同意”不能批准', async () => {
  mkdirSync(resolve('data'), { recursive: true }); const dir = mkdtempSync(resolve('data/channel-approval-')); writeFileSync(resolve(dir, 'approval.txt'), 'original');
  const mock = mockChannels(); let rounds = 0;
  const provider: Provider = { async *stream() {
    if (++rounds === 1) yield { type: 'complete', calls: [{ id: 'write', type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: 'approval.txt', content: 'changed' }) } }] };
    else { yield { type: 'delta', text: '覆盖完成' }; yield { type: 'complete', calls: [] }; }
  } };
  const f = await fixture(provider, dir, { factory: mock.factory });
  try {
    const a = await account(f); bind(f, a.id, a.userId); receive(f, a.id, 'write', '覆盖文件');
    await waitFor(() => !!f.db.prepare("SELECT id FROM tasks WHERE status='waiting_approval'").get()); f.channels.tick();
    assert.ok(f.db.prepare("SELECT id FROM channel_outbox WHERE text LIKE '%核对参数%'").get());
    receive(f, a.id, 'yes', '同意'); assert.equal(readFileSync(resolve(dir, 'approval.txt'), 'utf8'), 'original');
    const call = f.db.prepare('SELECT id,arguments_digest FROM tool_calls').get()!;
    const result = await f.app.inject({ method: 'POST', url: `/api/tool-calls/${call.id}/decision`, headers: f.headers, payload: { approved: true, argumentsDigest: call.arguments_digest } });
    assert.equal(result.statusCode, 200); await waitFor(() => rounds === 2); assert.equal(readFileSync(resolve(dir, 'approval.txt'), 'utf8'), 'changed');
  } finally { await f.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('投递失败不重跑模型、不自动重发，长回复分段有界且后续分段暂停', async () => {
  const mock = mockChannels(); let calls = 0;
  const f = await fixture({ async *stream() { calls++; yield { type: 'delta', text: '🙂'.repeat(9000) }; yield { type: 'complete', calls: [] }; } }, undefined, { factory: mock.factory });
  try {
    const a = await account(f); bind(f, a.id, a.userId); f.channels.tick(); await delay(0);
    mock.fail(); receive(f, a.id, 'long', '长回复'); await waitFor(() => calls === 1 && !!f.db.prepare("SELECT id FROM tasks WHERE status='succeeded'").get());
    f.channels.tick(); await delay(0); f.channels.tick(); await delay(0);
    const rows = f.db.prepare("SELECT o.* FROM channel_outbox o JOIN channel_inbox i ON i.id=o.inbox_id WHERE i.event_id='long' ORDER BY part").all();
    assert.equal(rows.length, 5); assert.equal(rows[0]!.status, 'unknown'); assert.equal(rows[1]!.status, 'pending');
    assert.ok(String(rows.at(-1)!.text).includes('完整内容')); assert.ok(rows.every(row => Array.from(String(row.text)).length <= 1500));
    for (let i = 0; i < 3; i++) { f.channels.tick(); await delay(0); } assert.equal(calls, 1);
    assert.ok(!JSON.stringify(f.channels.view(a.userId)).includes('secret-response'));
  } finally { await f.app.close(); }
});

test('重启保留入站墓碑，收到重复事件不恢复执行；不明投递不重发', async () => {
  const mock = mockChannels(); let calls = 0;
  const f = await fixture({ async *stream(_m, _t, signal) { calls++; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); signal.throwIfAborted(); yield { type: 'complete', calls: [] }; } }, undefined, { factory: mock.factory });
  let next: ChannelManager | undefined;
  try {
    const a = await account(f); bind(f, a.id, a.userId); receive(f, a.id, 'old', '产生副作用'); await waitFor(() => calls === 1);
    await f.channels.close(); await f.tasks.close();
    f.db.exec("UPDATE channel_inbox SET status='running' WHERE event_id='old'; UPDATE channel_outbox SET status='sending';");
    const tasks = new TaskManager(f.db, () => echo); next = new ChannelManager(f.db, tasks, mock.factory); next.start();
    next.receive(a.id, { eventId: 'old', text: '产生副作用', senderId: 'owner', replyContext: 'ctx' }); next.tick(); await delay(0);
    assert.equal(calls, 1); assert.equal(f.db.prepare("SELECT status FROM channel_inbox WHERE event_id='old'").get()!.status, 'interrupted');
    assert.equal(f.db.prepare('SELECT status FROM channel_outbox LIMIT 1').get()!.status, 'unknown');
    await next.close(); await tasks.close(); next = undefined;
  } finally { await next?.close(); await f.app.close(); }
});
