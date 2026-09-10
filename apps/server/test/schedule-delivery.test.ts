import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Schedule, ScheduleInput } from '@mlclaw/shared';
import { fixture, waitFor } from './helpers.js';
import { ChannelManager } from '../src/channels/manager.js';
import { DeliveryError, type OutboundMessage, type TransportFactory } from '../src/channels/types.js';
import { QQTransport } from '../src/channels/qq.js';
import { WeixinApi, WeixinTransport } from '../src/channels/weixin.js';
import { ScheduleManager } from '../src/schedules/manager.js';
import { openDatabase } from '../src/db/index.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

async function setup() {
  const sent: OutboundMessage[] = []; let fail = false; let calls = 0;
  const factory: TransportFactory = (_account, sink) => ({
    async run(signal) { sink.state('connected'); if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
    async send(message) { calls++; if (fail) throw new DeliveryError('unknown', 'secret-do-not-expose'); sent.push(message); },
  });
  let modelCalls = 0;
  const f = await fixture({ async *stream() { modelCalls++; yield { type: 'delta', text: '模拟定时 AI 结果' }; yield { type: 'complete', calls: [] }; } }, undefined, { factory });
  f.schedules.close();
  const userId = String(f.db.prepare('SELECT id FROM users').get()!.id);
  async function bind(kind: 'qq' | 'weixin', sender = 'owner') {
    const { id } = await f.channels.configure(userId, kind, kind, 'test-secret', kind === 'weixin' ? 'https://ilinkai.weixin.qq.com' : '');
    await f.channels.enable(id, userId, true);
    const { code } = f.channels.pairCode(id, userId);
    f.channels.receive(id, { eventId: crypto.randomUUID(), senderId: sender, text: `/bind ${code}`, replyContext: 'context-secret' });
    await waitFor(() => sent.some(m => m.text.includes('身份已绑定'))); sent.length = 0;
    return id;
  }
  async function create(channelId: string | null, kind: 'reminder' | 'agent' = 'reminder') {
    const input: ScheduleInput = { name: '投递测试', kind, content: '定时发送测试', cron: '* * * * *', enabled: true, deliveryChannelId: channelId };
    const response = await f.app.inject({ method: 'POST', url: '/api/schedules', headers: f.headers, payload: input });
    assert.equal(response.statusCode, 201, response.body); return response.json<Schedule>();
  }
  function run(plan: Schedule, key = 'test-key') { const occurrence = f.schedules.runNow(plan.id, userId, key, plan.version); f.schedules.tick(); return occurrence; }
  function status(id: string) { return f.db.prepare('SELECT status FROM schedule_deliveries WHERE occurrence_id=?').get(id)?.status; }
  return { ...f, userId, sent, bind, create, run, status, factory, fail() { fail = true; }, calls: () => calls, modelCalls: () => modelCalls };
}

test('定时 QQ 提醒只投递一次、微信 AI 使用本人最新上下文，站内保留且接口脱敏', async () => {
  const f = await setup();
  try {
    const qq = await f.bind('qq'); const plan = await f.create(qq); const occurrence = f.run(plan);
    await waitFor(() => f.status(occurrence.id) === 'sent');
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.text, '定时发送测试'); assert.equal(f.sent[0]!.proactive, true); assert.equal(f.sent[0]!.replyContext, '');
    assert.equal(f.run(plan).id, occurrence.id); f.channels.tick(); assert.equal(f.sent.length, 1);
    assert.equal(f.modelCalls(), 0);
    const wx = await f.bind('weixin');
    const ai = f.run(await f.create(wx, 'agent'), 'ai');
    await waitFor(() => !f.tasks.isBusy()); f.schedules.tick();
    await waitFor(() => f.status(ai.id) === 'sent');
    assert.ok(f.sent.some(m => m.text === '模拟定时 AI 结果' && m.replyContext === 'context-secret' && m.senderId === 'owner'));
    assert.equal(f.modelCalls(), 1);
    const response = await f.app.inject({ url: '/api/schedule-occurrences', headers: f.headers });
    assert.ok(response.body.includes('sent')); assert.ok(!response.body.includes('context-secret')); assert.ok(!response.body.includes('bindingVersion'));
    const local = f.run(await f.create(null), 'local'); f.channels.tick(); assert.equal(f.status(local.id), undefined);
  } finally { await f.app.close(); }
});

test('渠道选择校验归属、未绑定、非法参数；停用渠道仍可暂停原计划', async () => {
  const f = await setup();
  try {
    const qq = await f.bind('qq'); const plan = await f.create(qq);
    for (const deliveryChannelId of ['missing', 1, '', {}, true]) {
      const response = await f.app.inject({ method: 'POST', url: '/api/schedules', headers: f.headers,
        payload: { name: '测试', kind: 'reminder', content: '正文', cron: '* * * * *', enabled: true, deliveryChannelId } });
      assert.equal(response.statusCode, 400);
    }
    f.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('other', 'other', 'hash', 'now');
    assert.throws(() => f.schedules.store.save('other', { ...plan, deliveryChannelId: qq }), /已绑定/);
    await f.channels.enable(qq, f.userId, false);
    assert.doesNotThrow(() => f.schedules.store.save(f.userId, { ...plan, enabled: false }, plan.id, plan.version));
    assert.throws(() => f.schedules.store.save(f.userId, { ...plan, enabled: true }), /已绑定/);
    await f.channels.unpair(qq, f.userId); await f.channels.enable(qq, f.userId, true);
    assert.throws(() => f.schedules.store.save(f.userId, plan), /已绑定/);
  } finally { await f.app.close(); }
});

test('解除绑定再绑定同一个人也撤销旧投递快照，修改计划不改变已登记接收人', async () => {
  const f = await setup();
  try {
    const qq = await f.bind('qq'); const wx = await f.bind('weixin'); const plan = await f.create(qq);
    const occurrence = f.schedules.runNow(plan.id, f.userId, 'first', plan.version);
    // 已开始的执行固定渠道，模拟提醒完成后、投递前修改计划。
    f.schedules.tick();
    f.schedules.store.save(f.userId, { ...plan, deliveryChannelId: wx }, plan.id, plan.version);
    await waitFor(() => f.status(occurrence.id) === 'sent');
    assert.ok(f.sent.some(m => m.id === occurrence.id && m.replyContext === ''));
    const old = await f.create(qq);
    await f.channels.unpair(qq, f.userId); await f.channels.enable(qq, f.userId, true);
    const { code } = f.channels.pairCode(qq, f.userId);
    f.channels.receive(qq, { eventId: 'rebind', senderId: 'owner', text: `/bind ${code}`, replyContext: 'new-context' });
    const cancelled = f.run(old, 'rebound'); f.channels.tick();
    assert.equal(f.status(cancelled.id), 'cancelled'); assert.ok(!f.sent.some(m => m.id === cancelled.id));
  } finally { await f.app.close(); }
});

test('发送失败与重启均不重复投递或重新调用模型，历史结果保留', async () => {
  const f = await setup();
  try {
    const qq = await f.bind('qq'); const plan = await f.create(qq); f.fail();
    const occurrence = f.run(plan); await waitFor(() => f.status(occurrence.id) === 'unknown');
    const calls = f.calls(); f.channels.tick(); f.schedules.tick(); assert.equal(f.calls(), calls);
    const pending = f.run(plan, 'pending'); f.channels.tick();
    await f.channels.close();
    // 模拟崩溃留下的发送中/待发送，以及成功后尚未登记的间隙。
    f.db.prepare("UPDATE schedule_deliveries SET status='sending' WHERE occurrence_id=?").run(occurrence.id);
    f.db.prepare("UPDATE schedule_deliveries SET status='pending' WHERE occurrence_id=?").run(pending.id);
    const gap = f.run(plan, 'gap');
    const restarted = new ChannelManager(f.db, f.tasks, f.factory);
    assert.equal(f.status(occurrence.id), 'unknown'); assert.equal(f.status(pending.id), 'cancelled'); assert.equal(f.status(gap.id), 'cancelled');
    await restarted.close(); assert.equal(f.modelCalls(), 0);
    const response = await f.app.inject({ url: '/api/schedule-occurrences', headers: f.headers });
    assert.ok(!response.body.includes('secret-do-not-expose')); assert.ok(response.body.includes('定时发送测试'));
  } finally { await f.app.close(); }
});

test('投递内容有界、渠道移除后不会发送', async () => {
  const f = await setup();
  try {
    const qq = await f.bind('qq'); let plan = await f.create(qq);
    plan = f.schedules.store.save(f.userId, { ...plan, content: '长'.repeat(8000) }, plan.id, plan.version);
    const occurrence = f.run(plan); await waitFor(() => f.status(occurrence.id) === 'sent');
    assert.ok(Array.from(f.sent.find(m => m.id === occurrence.id)!.text).length <= 1400);
    assert.ok(f.sent.find(m => m.id === occurrence.id)!.text.includes('截断'));
    await f.channels.remove(qq, f.userId);
    const removed = f.run(plan, 'removed'); f.channels.tick(); assert.equal(f.status(removed.id), 'cancelled');
  } finally { await f.app.close(); }
});

test('缺少微信上下文明确失败，等待连接超时与取消任务不发送', async () => {
  const f = await setup();
  try {
    const wx = await f.bind('weixin'); const plan = await f.create(wx);
    f.db.prepare('DELETE FROM channel_inbox WHERE account_id=?').run(wx);
    const noContext = f.run(plan); await waitFor(() => f.status(noContext.id) === 'failed');
    const cancelled = f.schedules.runNow(plan.id, f.userId, 'cancel', plan.version);
    f.schedules.cancel(cancelled.id, f.userId); f.channels.tick(); assert.equal(f.status(cancelled.id), 'cancelled');
    await f.channels.close(); const offline = new ChannelManager(f.db, f.tasks, f.factory);
    const pending = f.run(plan, 'offline'); offline.tick(); assert.equal(f.status(pending.id), 'pending');
    f.db.prepare('UPDATE schedule_deliveries SET created_at=? WHERE occurrence_id=?').run('2000-01-01 00:00:00', pending.id);
    offline.tick(); assert.equal(f.status(pending.id), 'failed'); await offline.close();
    assert.equal(f.sent.length, 0);
  } finally { await f.app.close(); }
});

test('QQ 主动发送不带旧 msg_id，微信发送复用上下文，保留正常私聊回复协议', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes('getAppAccessToken')) return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 7200 }));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return new Response(JSON.stringify({ id: 'message', ret: 0 }));
  };
  const account = { id: 'a', userId: 'u', kind: 'qq' as const, remoteId: '123', secret: 'secret', baseUrl: 'https://ilinkai.weixin.qq.com', enabled: true, cursor: '', pairedSender: 'owner' };
  const sink = { receive() {}, cursor() {}, state() {} }; const signal = new AbortController().signal;
  const message: OutboundMessage = { id: 'one', eventId: 'event', senderId: 'owner', text: '提醒', replyContext: 'ctx', part: 2, proactive: true };
  const qq = new QQTransport(account, sink, fetcher);
  await qq.send(message, signal); assert.equal(bodies[0]!.msg_id, undefined); assert.equal(bodies[0]!.msg_seq, undefined);
  await qq.send({ ...message, proactive: false }, signal); assert.equal(bodies[1]!.msg_id, 'ctx'); assert.equal(bodies[1]!.msg_seq, 2);
  await new WeixinTransport({ ...account, kind: 'weixin' }, sink, new WeixinApi(fetcher)).send(message, signal);
  assert.equal((bodies[2]!.msg as Record<string, unknown>).context_token, 'ctx');
});

test('重启对账才发现成功的 AI 任务也不补发历史结果', async () => {
  const f = await setup();
  try {
    const qq = await f.bind('qq'); const plan = await f.create(qq, 'agent');
    await f.channels.close();
    const occurrence = f.run(plan); await waitFor(() => !f.tasks.isBusy());
    // 模拟 tasks 终态已写入，而发生记录终态尚未写入时崩溃。
    f.db.prepare("UPDATE schedule_occurrences SET status='running',finished_at=NULL WHERE id=?").run(occurrence.id);
    assert.equal(f.db.prepare('SELECT status FROM schedule_occurrences WHERE id=?').get(occurrence.id)!.status, 'running');
    const channels = new ChannelManager(f.db, f.tasks, f.factory);
    const schedules = new ScheduleManager(f.db, f.tasks);
    channels.tick(); assert.equal(f.status(occurrence.id), 'cancelled');
    schedules.close(); await channels.close(); assert.equal(f.modelCalls(), 1);
  } finally { await f.app.close(); }
});

test('第 13 版迁移保留原本人绑定与站内计划，重复打开不重置投递记录', () => {
  mkdirSync(resolve('data'), { recursive: true }); const dir = mkdtempSync(resolve('data/schedule-migration-')); const path = join(dir, 'db.sqlite');
  let db = openDatabase(path);
  try {
    db.exec('DROP TABLE system_log_settings; DROP TABLE system_logs; DELETE FROM schema_migrations WHERE version=14; DROP TABLE schedule_deliveries; ALTER TABLE schedule_occurrences DROP COLUMN delivery_target; ALTER TABLE schedules DROP COLUMN delivery_target; ALTER TABLE channel_accounts DROP COLUMN binding_version; DELETE FROM schema_migrations WHERE version=13;');
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('u','u','hash','now');
    db.prepare('INSERT INTO channel_accounts(id,user_id,kind,remote_id,secret,base_url,paired_sender,created_at) VALUES(?,?,?,?,?,?,?,?)').run('a','u','qq','123','secret','','owner','now');
    db.prepare('INSERT INTO schedules(id,user_id,name,kind,content,cron,enabled,version,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('s','u','原计划','reminder','内容','0 9 * * *',0,1,'Asia/Shanghai','now','now');
    db.close(); db = openDatabase(path);
    assert.equal(db.prepare('SELECT paired_sender FROM channel_accounts').get()!.paired_sender, 'owner');
    assert.equal(db.prepare('SELECT binding_version FROM channel_accounts').get()!.binding_version, 0);
    assert.equal(db.prepare('SELECT delivery_target FROM schedules').get()!.delivery_target, null);
    db.prepare('INSERT INTO schedule_occurrences(id,schedule_id,user_id,trigger_key,source,scheduled_at,snapshot,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('o','s','u','key','manual','now','{}','succeeded','now');
    db.prepare('INSERT INTO schedule_deliveries(occurrence_id,account_id,kind,text,status,created_at) VALUES(?,?,?,?,?,?)').run('o','a','qq','内容','sent','now');
    db.close(); db = openDatabase(path);
    assert.equal(db.prepare('SELECT status FROM schedule_deliveries').get()!.status, 'sent');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, 14);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
