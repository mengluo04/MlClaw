import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { QQTransport, parseQQMessage, qqGateway } from '../src/channels/qq.js';
import { WeixinApi, WeixinTransport, parseWeixinMessage, weixinBase } from '../src/channels/weixin.js';
import { requestJson, type Fetcher } from '../src/channels/http.js';
import type { ChannelAccount, ChannelSink, InboundMessage } from '../src/channels/types.js';
import { fixture, waitFor } from './helpers.js';

const account: ChannelAccount = { id: 'local', userId: 'owner', kind: 'weixin', remoteId: 'wxbot', secret: 'private-token', baseUrl: 'https://ilinkai.weixin.qq.com', enabled: true, cursor: '', pairedSender: 'sender' };
const message = { eventId: '123', senderId: 'sender', text: '你好', replyContext: 'context-secret' };
const outbound = { ...message, id: 'outbox', part: 2 };
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
const wireMessage = { message_id: 123, from_user_id: 'sender', message_type: 1, message_state: 2, context_token: 'context-secret', item_list: [{ type: 1, text_item: { text: '你好' } }] };

test('协议输入只接收私聊文本，拒绝精度丢失的 ID 和不受信任服务地址', () => {
  assert.deepEqual(parseWeixinMessage(wireMessage), message);
  assert.equal(parseWeixinMessage({ ...wireMessage, group_id: 'group' }), null);
  assert.equal(parseWeixinMessage({ ...wireMessage, message_type: 2 }), null);
  assert.throws(() => parseWeixinMessage({ ...wireMessage, message_id: Number.MAX_SAFE_INTEGER + 2 }));
  assert.equal(parseWeixinMessage({ ...wireMessage, item_list: [{ type: 2 }] })!.text, '');
  assert.deepEqual(parseQQMessage({ id: '123', author: { user_openid: 'sender' }, content: '你好' }), { ...message, replyContext: '123' });
  assert.throws(() => parseQQMessage({ id: '123', author: { username: 'sender' }, content: '你好' }));
  for (const base of ['http://ilinkai.weixin.qq.com', 'https://127.0.0.1', 'https://ilinkai.weixin.qq.com.evil.test', 'https://user@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443', 'https://ilinkai.weixin.qq.com/other']) assert.throws(() => weixinBase(base));
  assert.throws(() => qqGateway('ws://127.0.0.1')); assert.throws(() => qqGateway('wss://api.sgroup.qq.com.evil.test'));
});

test('微信轮询按落库后更新游标，保留上下文发送，登录失效停止', async () => {
  const ordered: string[] = []; const sent: Record<string, unknown>[] = []; let polls = 0;
  const fetcher: Fetcher = async (url, init) => {
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-token');
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('getupdates')) {
      assert.equal(body.get_updates_buf, polls === 0 ? '' : 'next-cursor');
      return ++polls === 1 ? json({ ret: 0, msgs: [wireMessage], get_updates_buf: 'next-cursor' }) : json({ ret: -14 });
    }
    sent.push(body); return json({ ret: 0 });
  };
  const states: string[] = []; const api = new WeixinApi(fetcher);
  const sink: ChannelSink = { receive(msg) { assert.deepEqual(msg, message); ordered.push('receive'); }, cursor(value) { ordered.push(value); }, state(state) { states.push(state); } };
  const transport = new WeixinTransport(account, sink, api); const controller = new AbortController();
  await transport.run(controller.signal); assert.deepEqual(ordered, ['receive', 'next-cursor']); assert.equal(states.at(-1), 'expired');
  await transport.send(outbound, controller.signal);
  assert.deepEqual((sent[0]!.msg as Record<string, unknown>).context_token, 'context-secret');
  assert.equal((sent[0]!.msg as Record<string, unknown>).client_id, 'mlclaw-outbox');
  assert.equal((sent[0]!.msg as Record<string, unknown>).to_user_id, 'sender');
});

test('微信持久化失败不推进游标，空游标可用，停止中止长轮询', async () => {
  let cursorCalled = false; const controller = new AbortController();
  const broken = new WeixinTransport(account, {
    receive() { controller.abort(); throw new Error('模拟数据库失败'); }, cursor() { cursorCalled = true; }, state() {},
  }, new WeixinApi(async () => json({ ret: 0, msgs: [wireMessage], get_updates_buf: 'next' })));
  await broken.run(controller.signal); assert.equal(cursorCalled, false);
  const stop = new AbortController(); let polls = 0;
  const transport = new WeixinTransport(account, { receive() {}, cursor(value) { assert.equal(value, ''); }, state() {} }, new WeixinApi(async (_url, init) => {
    if (++polls === 1) return json({ ret: 0, msgs: [], get_updates_buf: '' });
    return new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  }));
  const run = transport.run(stop.signal); await waitFor(() => polls === 2); stop.abort(); await run;
});

test('QQ 本地网关验证鉴权、心跳、持久化先于恢复游标以及停止清理', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); assert.ok(typeof address === 'object' && address);
  const controller = new AbortController(); const received: InboundMessage[] = []; const order: string[] = []; const payloads: Record<string, unknown>[] = []; let heartbeat = false;
  server.on('connection', socket => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on('message', raw => {
      const payload = JSON.parse(raw.toString()); payloads.push(payload);
      if (payload.op === 2) {
        socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'qq-session' } }));
        socket.send(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: '123', author: { user_openid: 'sender' }, content: '你好' } }));
      }
      if (payload.op === 1) { heartbeat = true; socket.send(JSON.stringify({ op: 11 })); }
    });
  });
  const http: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}; http.push({ url: String(url), body, headers: new Headers(init?.headers) });
    if (String(url).includes('getAppAccessToken')) return json({ access_token: 'qq-token', expires_in: 7200 });
    if (String(url).endsWith('/gateway')) return json({ url: 'wss://api.sgroup.qq.com/websocket' });
    return json({ id: 'sent-id' });
  };
  const transport = new QQTransport({ ...account, kind: 'qq', remoteId: '123' }, {
    receive(msg) { received.push(msg); order.push('receive'); }, cursor(value) { order.push(`cursor-${JSON.parse(value).sequence}`); }, state() {},
  }, fetcher, () => new WebSocket(`ws://127.0.0.1:${address.port}`));
  const run = transport.run(controller.signal);
  try {
    await waitFor(() => received.length === 1 && heartbeat);
    assert.deepEqual(order, ['cursor-1', 'receive', 'cursor-2']);
    assert.equal((payloads[0]!.d as Record<string, unknown>).token, 'QQBot qq-token');
    await transport.send({ ...outbound, replyContext: '123' }, controller.signal);
    assert.equal(http.at(-1)!.body.msg_seq, 2); assert.equal(http.at(-1)!.body.msg_id, '123'); assert.equal(http.at(-1)!.headers.get('authorization'), 'QQBot qq-token');
    assert.equal(http.filter(item => item.url.includes('getAppAccessToken')).length, 1);
  } finally { controller.abort(); await run; for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('QQ 网关恢复使用持久化游标，入站处理失败不提交新游标', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const controller = new AbortController(); let resumed = false; let updated = false; let admitted = false;
  server.on('connection', socket => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on('message', raw => { const payload = JSON.parse(raw.toString()); if (payload.op === 6) { resumed = payload.d.seq === 4 && payload.d.session_id === 'old'; socket.send(JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 5, d: { id: '5', author: { user_openid: 'sender' }, content: '你好' } })); } });
  });
  const transport = new QQTransport({ ...account, kind: 'qq', cursor: JSON.stringify({ sessionId: 'old', sequence: 4 }) }, {
    receive() { admitted = true; throw new Error('模拟落库失败'); }, cursor() { updated = true; }, state() {},
  }, async url => String(url).includes('getAppAccessToken') ? json({ access_token: 'token', expires_in: 7200 }) : json({ url: 'wss://api.sgroup.qq.com/websocket' }), () => new WebSocket(`ws://127.0.0.1:${address.port}`));
  const run = transport.run(controller.signal);
  try { await waitFor(() => admitted); assert.equal(resumed, true); assert.equal(updated, false); }
  finally { controller.abort(); await run; for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('平台 HTTP 错误脱敏、限制响应体，并拒绝无效 JSON', async () => {
  await assert.rejects(requestJson('https://example.test', {}, async () => new Response('secret-key', { status: 500 })), error => error instanceof Error && !error.message.includes('secret'));
  await assert.rejects(requestJson('https://example.test', {}, async () => new Response('x'.repeat(1024 * 1024 + 1))), /大小/);
  await assert.rejects(requestJson('https://example.test', {}, async () => new Response('not-json')), /格式/);
  const large = await requestJson('https://example.test', {}, async () => new Response('{"message_id":18446744073709551615}'));
  assert.equal(large.message_id, '18446744073709551615');
  assert.equal(parseWeixinMessage({ ...wireMessage, message_id: large.message_id })!.eventId, '18446744073709551615');
});

test('微信扫码 HTTP 流程：验证码、恢复查询、用户隔离、凭据不回传与取消', async () => {
  let verified = false;
  const api = new WeixinApi(async (url, init) => {
    if (String(url).includes('get_bot_qrcode')) { assert.equal(init?.method, 'POST'); return json({ qrcode: 'qr-secret', qrcode_img_content: 'https://example.test/scan' }); }
    if (String(url).includes('verify_code=123456')) { verified = true; return json({ status: 'confirmed', bot_token: 'login-secret', ilink_bot_id: 'wx-bot', baseurl: 'https://ilinkai.weixin.qq.com' }); }
    return json({ status: 'need_verifycode' });
  });
  const factory = () => ({ async run(signal: AbortSignal) { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }, async send() {} });
  const f = await fixture(undefined, undefined, { factory, weixinApi: api });
  try {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/channels/weixin/login', headers: { origin: f.headers.origin } })).statusCode, 401);
    const response = await f.app.inject({ method: 'POST', url: '/api/channels/weixin/login', headers: f.headers });
    assert.equal(response.statusCode, 200); const session = response.json(); assert.ok(session.qrDataUrl.startsWith('data:image/png;base64,'));
    assert.ok(!response.body.includes('qr-secret')); await delay(0);
    assert.equal((await f.app.inject({ url: '/api/channels/weixin/login', headers: f.headers })).json().state, 'need_verifycode');
    assert.throws(() => f.channelLogin.view('other-user', session.id), /不存在/);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/channels/weixin/login', headers: f.headers })).statusCode, 409);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/channels/weixin/login/${session.id}/verify`, headers: f.headers, payload: { code: '123456' } })).statusCode, 200);
    await waitFor(() => verified); await waitFor(() => !!f.db.prepare("SELECT id FROM channel_accounts WHERE kind='weixin'").get());
    const view = await f.app.inject({ url: '/api/channels', headers: f.headers }); assert.ok(!view.body.includes('login-secret')); assert.equal(view.json().accounts[0].pairedSender, null);
    assert.equal((await f.app.inject({ url: `/api/channels/weixin/login/${session.id}`, headers: f.headers })).json().state, 'confirmed');
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/channels/weixin/login/${session.id}`, headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject({ url: '/api/channels/weixin/login', headers: f.headers })).json(), null);
  } finally { await f.app.close(); }
});

test('微信扫码过期及未知重定向不保存凭据', async () => {
  for (const status of [{ status: 'expired' }, { status: 'scaned_but_redirect', redirect_host: 'evil.test' }, { status: 'confirmed', ilink_bot_id: 'bot', bot_token: 'token', baseurl: 'https://127.0.0.1' }]) {
    const f = await fixture(undefined, undefined, { weixinApi: new WeixinApi(async url => String(url).includes('get_bot_qrcode') ? json({ qrcode: 'q', qrcode_img_content: 'qr' }) : json(status)) });
    try {
      const session = await f.channelLogin.start(String(f.db.prepare('SELECT id FROM users').get()!.id));
      await waitFor(() => ['expired', 'error'].includes(f.channelLogin.current(String(f.db.prepare('SELECT id FROM users').get()!.id))!.state));
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM channel_accounts').get()!.n, 0); assert.ok(session.id);
    } finally { await f.app.close(); }
  }
});

test('取消扫码后丢弃迟到的 confirmed，不保存账号或启动渠道', async () => {
  let resolveStatus: ((response: Response) => void) | undefined;
  const f = await fixture(undefined, undefined, { weixinApi: new WeixinApi(async url => String(url).includes('get_bot_qrcode') ? json({ qrcode: 'q', qrcode_img_content: 'qr' }) : new Promise<Response>(resolve => { resolveStatus = resolve; })) });
  try {
    const userId = String(f.db.prepare('SELECT id FROM users').get()!.id);
    const login = await f.channelLogin.start(userId); await waitFor(() => !!resolveStatus);
    const cancel = f.channelLogin.cancel(userId, login.id);
    resolveStatus!(json({ status: 'confirmed', ilink_bot_id: 'bot', bot_token: 'late-token', baseurl: 'https://ilinkai.weixin.qq.com' })); await cancel;
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM channel_accounts').get()!.n, 0); assert.equal(f.channelLogin.current(userId), null);
  } finally { await f.app.close(); }
});

test('QQ 认证失败清除缓存，下一次发送刷新令牌；中止请求不发送消息', async () => {
  let tokens = 0; let sends = 0;
  const transport = new QQTransport({ ...account, kind: 'qq' }, { receive() {}, state() {}, cursor() {} }, async (url, init) => {
    if (String(url).includes('getAppAccessToken')) return json({ access_token: `token-${++tokens}`, expires_in: 7200 });
    sends++; if (sends === 1) return json({ message: 'private-error' }, 401);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'QQBot token-2'); return json({ id: 'sent' });
  });
  const controller = new AbortController();
  await assert.rejects(transport.send(outbound, controller.signal), error => error instanceof Error && !error.message.includes('private-error'));
  await transport.send(outbound, controller.signal); assert.equal(tokens, 2);
  controller.abort(); await assert.rejects(transport.send(outbound, controller.signal)); assert.equal(sends, 2);
});
