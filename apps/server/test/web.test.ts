import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { WebSettings, WebSettingsInput } from '@mlclaw/shared';
import { fixture, waitFor } from './helpers.js';
import { getWebConfig, publicWebConfig, saveWebConfig } from '../src/web/store.js';
import { TavilyProvider, publicUrl } from '../src/web/tavily.js';
import { openDatabase, transaction } from '../src/db/index.js';
import type { ToolCall } from '../src/providers/types.js';

const key = 'tvly-mock-private-key';
const input: WebSettingsInput = { provider: 'tavily', enabled: true, allowFetch: true, allowSchedules: false, apiKey: key, expectedVersion: 0 };
const call = (name: string, args: object): ToolCall => ({ id: 'mock-call', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const signal = () => new AbortController().signal;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const result = { title: '官方资料', url: 'https://www.example.com/article', content: '搜索摘要' };
const response = () => json({ results: [result] });
function owner(db: ReturnType<typeof openDatabase>) { return String(db.prepare('SELECT id FROM users').get()!.id); }

test('联网配置 API：默认关闭、脱敏、归属、Origin、版本冲突、替换及清除密钥', async () => {
  const f = await fixture(); const { app, db, headers } = f; const userId = owner(db);
  const save = (payload: object, h = headers) => app.inject({ method: 'PUT', url: '/api/settings/web', headers: h, payload });
  try {
    assert.equal((await app.inject({ url: '/api/settings/web' })).statusCode, 401);
    assert.equal((await save(input, { origin: 'https://evil.example', cookie: headers.cookie })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/settings/web/test', headers: { origin: headers.origin }, payload: { expectedVersion: 0 } })).statusCode, 401);
    const defaults = (await app.inject({ url: '/api/settings/web', headers })).json<WebSettings>();
    assert.equal(defaults.enabled, false); assert.equal(defaults.allowSchedules, false); assert.equal(defaults.hasApiKey, false);
    for (const payload of [{ ...input, enabled: 'true' }, { ...input, provider: 'other' }, { ...input, userId: 'other' }, { ...input, expectedVersion: -1 }, { ...input, apiKey: ' ' }, { ...input, apiKey: 'key\nunsafe' }]) {
      assert.equal((await save(payload)).statusCode, 400);
    }
    assert.equal((await save(input)).statusCode, 200);
    assert.equal((await save(input)).statusCode, 409);
    const settings = (await app.inject({ url: '/api/settings/web', headers })).json<WebSettings>();
    assert.equal(settings.version, 1); assert.equal(settings.hasApiKey, true); assert.ok(!JSON.stringify(settings).includes(key));
    assert.match(settings.updatedAt!, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('other-web', 'other-web', 'hash', 'now');
    saveWebConfig(db, 'other-web', { ...input, apiKey: 'other-secret' });
    assert.equal(getWebConfig(db, userId).apiKey, key);
    assert.ok(!(await app.inject({ url: '/api/settings/web', headers })).body.includes('other-secret'));
    const { apiKey: _, ...withoutKey } = input;
    assert.equal((await save({ ...withoutKey, expectedVersion: 1, allowFetch: false })).statusCode, 200);
    assert.equal(getWebConfig(db, userId).apiKey, key);
    assert.equal((await save({ ...input, expectedVersion: 2, apiKey: 'replacement-key' })).statusCode, 200);
    assert.equal(getWebConfig(db, userId).apiKey, 'replacement-key');
    const cleared = await save({ ...input, expectedVersion: 3, apiKey: '' });
    assert.equal(cleared.statusCode, 200); assert.equal(cleared.json().enabled, false); assert.equal(cleared.json().hasApiKey, false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/settings/web/test', headers, payload: { expectedVersion: 4 } })).statusCode, 400);
  } finally { await app.close(); }
});

test('连接测试使用已保存配置及固定查询，校验版本、限制频率并脱敏失败', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const f = await fixture(undefined, undefined, undefined, undefined, async (url, init) => { requests.push({ url: String(url), init }); return response(); });
  try {
    saveWebConfig(f.db, owner(f.db), { ...input, enabled: false });
    const run = (expectedVersion: number) => f.app.inject({ method: 'POST', url: '/api/settings/web/test', headers: f.headers, payload: { expectedVersion } });
    assert.equal((await run(0)).statusCode, 409); assert.equal(requests.length, 0);
    const tested = await run(1); assert.equal(tested.statusCode, 200); assert.equal(tested.json().resultCount, 1);
    assert.equal(typeof tested.json().durationMs, 'number'); assert.ok(!tested.body.includes(key));
    assert.equal(requests[0]!.url, 'https://api.tavily.com/search');
    assert.equal(new Headers(requests[0]!.init!.headers).get('authorization'), `Bearer ${key}`);
    assert.equal(requests[0]!.init!.redirect, 'error');
    assert.equal(JSON.parse(String(requests[0]!.init!.body)).query, 'Tavily documentation');
    assert.equal((await run(1)).statusCode, 429); assert.equal(requests.length, 1);
  } finally { await f.app.close(); }
  const failure = await fixture(undefined, undefined, undefined, undefined, async () => json({ detail: key }, 401));
  try {
    saveWebConfig(failure.db, owner(failure.db), input);
    const res = await failure.app.inject({ method: 'POST', url: '/api/settings/web/test', headers: failure.headers, payload: { expectedVersion: 1 } });
    assert.equal(res.statusCode, 502); assert.match(res.body, /认证失败/); assert.ok(!res.body.includes(key));
  } finally { await failure.app.close(); }
});

test('Tavily 适配：搜索与正文来源、截断、密钥过滤、无结果及请求参数', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const provider = new TavilyProvider(key, async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init!.body)) });
    return String(url).endsWith('/search')
      ? json({ results: [{ ...result, content: key + '中'.repeat(1000), published_date: '2026-09-09' }] })
      : json({ results: [{ url: result.url, raw_content: '网页正文'.repeat(3000) }] });
  });
  const search = await provider.search('中文查询', 5, signal());
  assert.equal(search.results[0]!.url, result.url); assert.equal(search.results[0]!.publishedAt, '2026-09-09');
  assert.equal(search.results[0]!.snippet.length, 700); assert.equal(search.truncated, true); assert.ok(!JSON.stringify(search).includes(key));
  assert.equal(search.referenceOnly, true); assert.match(search.fetchedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const page = await provider.extract(result.url, signal());
  assert.equal(page.content.length, 6000); assert.equal(page.truncated, true); assert.equal(page.title, null); assert.equal(page.url, result.url);
  assert.equal(requests[0]!.body.include_raw_content, false); assert.equal(requests[0]!.body.auto_parameters, false);
  assert.equal(requests[1]!.url, 'https://api.tavily.com/extract'); assert.deepEqual(requests[1]!.body.urls, [result.url]);
  const empty = new TavilyProvider(key, async () => json({ results: [], failed_results: [{ error: key }] }));
  assert.deepEqual((await empty.search('无结果', 5, signal())).results, []);
  await assert.rejects(empty.extract(result.url, signal()), /无法读取/);
  const oversized = new TavilyProvider(key, async () => json({ results: Array.from({ length: 5 }, () => ({ title: '"'.repeat(200), content: '\n'.repeat(700), url: 'https://example.com/' + 'a'.repeat(2000) })) }));
  assert.ok(JSON.stringify(await oversized.search('预算', 5, signal())).length < 16000);
});

test('网络边界：拒绝危险 URL、上游错误/非法结构/超大响应，不直接访问网页目标', async () => {
  for (const url of ['file:///etc/passwd', 'http://localhost/a', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://192.168.0.1', 'http://169.254.169.254', 'https://user:pass@example.com', 'https://example.com:8443', 'http://host.internal', 'http://host.local', 'http://singlehost', 'https://example.com/\nsecret']) {
    assert.throws(() => publicUrl(url));
  }
  assert.equal(publicUrl('https://example.com/page#fragment'), 'https://example.com/page');
  assert.throws(() => publicUrl('https://example.com/' + '中'.repeat(500)), /编码后/);
  for (const [status, message] of [[429, /受限/], [432, /额度/], [500, /HTTP 500/], [302, /HTTP 302/]] as const) {
    const provider = new TavilyProvider(key, async () => json({ secret: key }, status));
    await assert.rejects(provider.search('test', 1, signal()), message);
  }
  for (const body of ['invalid-json', '{}', '{"results":[{"url":"https://example.com"}]}', 'x'.repeat(1024 * 1024 + 1)]) {
    const provider = new TavilyProvider(key, async () => new Response(body));
    await assert.rejects(provider.search('test', 1, signal()), error => error instanceof Error && !error.message.includes(key));
  }
  let count = 0;
  const provider = new TavilyProvider(key, async () => { count++; throw new Error(key); });
  await assert.rejects(provider.extract('http://127.0.0.1', signal())); assert.equal(count, 0);
  await assert.rejects(provider.search('test', 1, signal()), /连接失败/);
});

test('工具权限：默认隐藏、定时任务独立开关、运行快照、撤销、参数校验与每任务预算', async () => {
  let requests = 0;
  const f = await fixture(undefined, undefined, undefined, undefined, async () => { requests++; return response(); });
  const userId = owner(f.db);
  try {
    const before = f.tasks.registryFor(userId);
    assert.ok(!before.definitions().some(tool => tool.function.name.startsWith('web_')));
    saveWebConfig(f.db, userId, input);
    assert.throws(() => before.prepare(call('web_search', { query: 'test' })));
    const full = f.tasks.registryFor(userId); const readonly = f.tasks.registryFor(userId, 'readonly');
    assert.ok(full.definitions().some(tool => tool.function.name === 'web_search'));
    assert.ok(!full.definitions('readonly').some(tool => tool.function.name.startsWith('web_')));
    assert.throws(() => readonly.prepare(call('web_search', { query: 'test' }), 'readonly'));
    for (const args of [{ query: ' ' }, { query: 'a', maxResults: 6 }, { query: 'a', url: result.url }]) assert.throws(() => full.prepare(call('web_search', args)));
    const prepared = full.prepare(call('web_search', { query: '资料' }));
    assert.equal(prepared.approval, false); assert.ok(!JSON.stringify(prepared).includes(key));
    for (let i = 0; i < 6; i++) assert.ok(JSON.parse(await full.execute(prepared, signal())).results.length);
    await assert.rejects(full.execute(prepared, signal()), /6 次/); assert.equal(requests, 6);
    saveWebConfig(f.db, userId, { ...input, expectedVersion: 1, allowSchedules: true });
    assert.throws(() => readonly.prepare(call('web_search', { query: 'test' }), 'readonly')); // 原快照不能升级权限。
    const scheduled = f.tasks.registryFor(userId, 'readonly');
    const allowed = scheduled.prepare(call('web_search', { query: 'test' }), 'readonly');
    await scheduled.execute(allowed, signal(), 'readonly');
    assert.throws(() => scheduled.prepare(call('write_text', { path: 'no.txt', content: 'no' }), 'readonly'), /禁止/);
    saveWebConfig(f.db, userId, { ...input, expectedVersion: 2, allowSchedules: true, allowFetch: false });
    assert.throws(() => scheduled.prepare(call('web_fetch', { url: result.url }), 'readonly'));
    const noFetch = f.tasks.registryFor(userId);
    assert.ok(!noFetch.definitions().some(tool => tool.function.name === 'web_fetch'));
    saveWebConfig(f.db, userId, { ...input, expectedVersion: 3, apiKey: 'replacement-key' });
    await assert.rejects(scheduled.execute(allowed, signal(), 'readonly'), /撤销/);
    const fresh = f.tasks.registryFor(userId); const ready = fresh.prepare(call('web_search', { query: 'test' }));
    saveWebConfig(f.db, userId, { ...input, expectedVersion: 4, apiKey: '' });
    await assert.rejects(fresh.execute(ready, signal()), /撤销/);
    assert.equal(requests, 7);
  } finally { await f.app.close(); }
});

test('真实 Agent 循环与 HTTP/SSE：模拟搜索、读网页、引用，任务快照无密钥，同键不重放', async () => {
  let network = 0; let rounds = 0;
  const f = await fixture({ async *stream(messages, tools) {
    rounds++; assert.ok(tools.some(tool => tool.function.name === 'web_search'));
    if (rounds === 1) { yield { type: 'complete', calls: [call('web_search', { query: '官方资料' })] }; return; }
    if (rounds === 2) { assert.match(messages.at(-1)!.content, /搜索摘要/); yield { type: 'complete', calls: [call('web_fetch', { url: result.url })] }; return; }
    assert.match(messages.at(-1)!.content, /正文证据/);
    yield { type: 'delta', text: `模拟结论，依据[官方资料](${result.url})。` }; yield { type: 'complete', calls: [] };
  } }, undefined, undefined, undefined, async url => {
    network++; return String(url).endsWith('/search') ? response() : json({ results: [{ url: result.url, raw_content: '正文证据' }] });
  });
  const userId = owner(f.db);
  try {
    saveWebConfig(f.db, userId, input);
    const send = () => f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers, payload: { content: '查询资料', idempotencyKey: 'web-once' } });
    const sent = await send(); assert.equal(sent.statusCode, 202); const taskId = sent.json().taskId;
    await waitFor(() => !f.tasks.isActive(taskId));
    const task = await f.app.inject({ url: `/api/tasks/${taskId}`, headers: f.headers });
    assert.equal(task.json().status, 'succeeded'); assert.equal(task.json().tools.length, 2);
    assert.equal(JSON.parse(task.json().web_snapshot).version, 1); assert.ok(!task.body.includes(key));
    const sse = await f.app.inject({ url: `/api/tasks/${taskId}/events`, headers: f.headers });
    assert.match(sse.body, /tool.started/); assert.match(sse.body, /tool.finished/); assert.ok(!sse.body.includes(key));
    assert.equal((await send()).json().taskId, taskId); assert.equal(network, 2); assert.equal(rounds, 3);
    const preview = await f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/rules/preview`, headers: f.headers, payload: { content: '' } });
    assert.match(preview.body, /web_search/); assert.ok(!preview.body.includes(key));
  } finally { await f.app.close(); }
});

test('创建时配置快照和定时策略：启用不提升旧任务权限，定时任务按当前许可注册联网', async () => {
  const seen: string[][] = [];
  const f = await fixture({ async *stream(_messages, tools) { seen.push(tools.map(tool => tool.function.name)); yield { type: 'complete', calls: [] }; } });
  const userId = owner(f.db);
  try {
    const first = f.tasks.create(userId, f.conversationId, '创建时禁用', 'snapshot');
    saveWebConfig(f.db, userId, input);
    await waitFor(() => !f.tasks.isActive(first)); assert.ok(!seen[0]!.includes('web_search'));
    const start = (id: string) => { const prepared = transaction(f.db, () => f.tasks.prepare(userId, f.conversationId, '定时模拟', id, 'readonly')); prepared.start(); return prepared.taskId; };
    const second = start('readonly-off'); await waitFor(() => !f.tasks.isActive(second)); assert.ok(!seen[1]!.includes('web_search'));
    saveWebConfig(f.db, userId, { ...input, expectedVersion: 1, allowSchedules: true });
    const third = start('readonly-on'); await waitFor(() => !f.tasks.isActive(third));
    assert.ok(seen[2]!.includes('web_search')); assert.ok(!seen[2]!.includes('write_text'));
  } finally { await f.app.close(); }
});

test('取消与配置撤销终止正在执行的网络请求，迟到结果不写入', async () => {
  for (const revoke of [false, true]) {
    let started = false; let aborted = false;
    const f = await fixture({ async *stream() { yield { type: 'complete', calls: [call('web_search', { query: '等待' })] }; } }, undefined, undefined, undefined,
      async (_url, init) => new Promise<Response>((_resolve, reject) => {
        started = true;
        init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
      }));
    const userId = owner(f.db);
    try {
      saveWebConfig(f.db, userId, input);
      const id = f.tasks.create(userId, f.conversationId, '等待联网', 'cancel'); await waitFor(() => started);
      if (revoke) await f.app.inject({ method: 'PUT', url: '/api/settings/web', headers: f.headers, payload: { ...input, expectedVersion: 1, enabled: false } });
      else f.tasks.cancel(id, userId);
      await waitFor(() => aborted && !f.tasks.isBusy());
      assert.equal(f.tasks.get(id, userId).status, revoke ? 'failed' : 'cancelled');
      assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM tool_calls').all()).includes(key));
    } finally { await f.app.close(); }
  }
});

test('第 10 版迁移保留已有会话与任务，联网默认关闭，配置重开保留且不重放', () => {
  const root = resolve('data'); mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'web-migration-'));
  const path = join(directory, 'test.sqlite'); let db = openDatabase(path);
  try {
    db.exec("DROP TABLE system_log_settings; DROP TABLE system_logs; DELETE FROM schema_migrations WHERE version=14; DROP TABLE schedule_deliveries; ALTER TABLE schedule_occurrences DROP COLUMN delivery_target; ALTER TABLE schedules DROP COLUMN delivery_target; ALTER TABLE channel_accounts DROP COLUMN binding_version; DELETE FROM schema_migrations WHERE version=13; DROP TABLE task_skill_loads; DROP TABLE task_skills; DROP TABLE skills; DROP TRIGGER summary_message_update; DROP TRIGGER summary_message_delete; DROP TABLE conversation_context; DROP INDEX tasks_user_history; ALTER TABLE tasks DROP COLUMN kind; ALTER TABLE tasks DROP COLUMN context_snapshot; DROP TABLE web_settings; ALTER TABLE tasks DROP COLUMN web_snapshot; DELETE FROM schema_migrations WHERE version>=10;");
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('u', 'u', 'hash', '2026-09-09 12:00:00');
    db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run('c', 'u', '旧会话', '2026-09-09 12:00:00');
    db.prepare("INSERT INTO tasks (id,user_id,conversation_id,status,idempotency_key,input,created_at) VALUES ('t','u','c','succeeded','old','旧任务','2026-09-09 12:00:00')").run();
    db.close(); db = openDatabase(path);
    assert.equal(getWebConfig(db, 'u').enabled, false); assert.equal(db.prepare('SELECT web_snapshot FROM tasks').get()!.web_snapshot, null);
    const saved = saveWebConfig(db, 'u', input); db.close(); db = openDatabase(path);
    assert.deepEqual(publicWebConfig(getWebConfig(db, 'u')), saved); assert.equal(getWebConfig(db, 'u').apiKey, key);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, 14); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); assert.ok(directory.startsWith(root + sep)); rmSync(directory, { recursive: true }); }
});

test('联网请求 8 秒超时会中止传输，提前取消不会发送请求，迟到结果被拒绝', async () => {
  let requests = 0; let aborted = false;
  const f = await fixture(undefined, undefined, undefined, undefined, async (_url, init) => {
    requests++;
    // 模拟上游在取消后仍返回结果，服务必须拒绝此迟到响应。
    await new Promise<void>(resolve => init!.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return response();
  });
  const userId = owner(f.db);
  try {
    saveWebConfig(f.db, userId, input);
    const session = f.tasks.web.session(userId, 'full');
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(session.execute('web_search', { query: '取消' }, cancelled.signal)); assert.equal(requests, 0);
    await assert.rejects(session.execute('web_search', { query: '等待超时' }, signal()), /超时/);
    assert.equal(requests, 1); assert.equal(aborted, true);
    f.tasks.web.close();
    await assert.rejects(session.execute('web_search', { query: '关闭后' }, signal()), /正在关闭/);
    assert.equal(requests, 1);
  } finally { await f.app.close(); }
});
