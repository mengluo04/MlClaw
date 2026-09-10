import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { ModelSettings } from '@mlclaw/shared';
import { fixture, waitFor } from './helpers.js';
import { getModelConfig, getSettings, saveProvider, setDefault, deleteProvider } from '../src/models/store.js';
import { openDatabase } from '../src/db/index.js';

test('多提供商接口：模型校验、唯一默认、删除保护、密钥隔离和对象归属', async () => {
  const f = await fixture(); const { app, db, headers, conversationId } = f;
  const input = { name: '服务甲', baseUrl: 'https://a.example/v1', models: ['a1', 'a2'], apiKey: 'private-a-key' };
  try {
    const send = () => app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers, payload: { content: '你好', idempotencyKey: 'no-default' } });
    assert.equal((await send()).statusCode, 400);
    for (const models of [[], [' '], ['a', ' a '], Array(51).fill('x')]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/settings/providers', headers, payload: { ...input, models } })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/settings/providers', headers: { origin: headers.origin }, payload: input })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/settings/providers', headers: { cookie: headers.cookie }, payload: input })).statusCode, 403);
    const a = (await app.inject({ method: 'POST', url: '/api/settings/providers', headers, payload: input })).json().id as string;
    const b = (await app.inject({ method: 'POST', url: '/api/settings/providers', headers, payload: { ...input, name: '服务乙', apiKey: 'private-b-key' } })).json().id as string;
    assert.equal((await send()).statusCode, 400); // 配置存在不等于已指定默认。
    const choose = (providerId: string, model: string) => app.inject({ method: 'PUT', url: '/api/settings/model-default', headers, payload: { providerId, model } });
    assert.equal((await choose(a, 'missing')).statusCode, 404);
    assert.equal((await choose(a, 'a2')).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/settings/providers/${a}`, headers })).statusCode, 409);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/settings/providers/${a}`, headers, payload: { ...input, models: ['a1'] } })).statusCode, 409);
    assert.equal((await choose(b, 'a1')).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/settings/providers/${a}`, headers })).statusCode, 200);
    const userId = String(db.prepare('SELECT id FROM users').get()!.id);
    assert.equal(getModelConfig(db, userId)!.apiKey, 'private-b-key');
    assert.equal((await app.inject({ method: 'PUT', url: `/api/settings/providers/${b}`, headers, payload: { name: '乙', models: ['a1'], baseUrl: 'https://b.example/v1' } })).statusCode, 200);
    assert.equal(getModelConfig(db, userId)!.apiKey, '');
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('other', 'other', 'hash', 'now');
    const foreign = saveProvider(db, 'other', input).id;
    assert.equal((await choose(foreign, 'a1')).statusCode, 404);
    for (const method of ['PUT', 'DELETE', 'POST'] as const) {
      const result = await app.inject({ method, url: `/api/settings/providers/${foreign}${method === 'POST' ? '/test' : ''}`, headers, ...(method === 'DELETE' ? {} : { payload: method === 'POST' ? { model: 'a1' } : input }) });
      assert.equal(result.statusCode, 404);
    }
    const result = await app.inject({ url: '/api/settings/models', headers });
    const settings = result.json<ModelSettings>();
    assert.equal(settings.providers.length, 1); assert.equal(settings.providers[0]!.hasApiKey, false);
    assert.deepEqual(settings.defaultModel, { providerId: b, model: 'a1' });
    assert.ok(!result.body.includes('private-')); assert.ok(!result.body.includes(foreign));
    assert.equal(db.prepare('SELECT count(*) AS n FROM model_defaults WHERE user_id=?').get(userId)!.n, 1);
  } finally { await app.close(); }
});

test('旧单模型迁移保留地址密钥及全局默认，重复打开不重复迁移', () => {
  const root = resolve('data'); mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'models-'));
  const path = join(directory, 'migration.sqlite'); let db = openDatabase(path);
  try {
    db.exec(`DROP TABLE model_defaults; DROP TABLE model_providers; ALTER TABLE tasks DROP COLUMN model_snapshot;
      CREATE TABLE model_configs (user_id TEXT PRIMARY KEY REFERENCES users(id),base_url TEXT NOT NULL,model TEXT NOT NULL,api_key TEXT NOT NULL,updated_at TEXT NOT NULL);
      DROP TABLE system_log_settings; DROP TABLE system_logs; DELETE FROM schema_migrations WHERE version=14; DROP TABLE schedule_deliveries; ALTER TABLE schedule_occurrences DROP COLUMN delivery_target; ALTER TABLE schedules DROP COLUMN delivery_target; ALTER TABLE channel_accounts DROP COLUMN binding_version; DELETE FROM schema_migrations WHERE version=13; DROP TABLE task_skill_loads; DROP TABLE task_skills; DROP TABLE skills; DROP TRIGGER summary_message_update; DROP TRIGGER summary_message_delete; DROP TABLE conversation_context; DROP INDEX tasks_user_history; ALTER TABLE tasks DROP COLUMN kind; ALTER TABLE tasks DROP COLUMN context_snapshot; DROP TABLE web_settings; ALTER TABLE tasks DROP COLUMN web_snapshot; DROP TABLE schedule_occurrences; DROP TABLE schedules; ALTER TABLE tasks DROP COLUMN tool_policy; DROP TABLE channel_outbox; DROP TABLE channel_inbox; DROP TABLE channel_conversations; DROP TABLE channel_accounts;
      DELETE FROM schema_migrations WHERE version>=6;`);
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('legacy', 'legacy', 'hash', 'now');
    db.prepare('INSERT INTO model_configs VALUES (?,?,?,?,?)').run('legacy', 'https://legacy.example/v1', 'old-model', 'legacy-key', 'now');
    db.close(); db = openDatabase(path);
    const settings = getSettings(db, 'legacy');
    assert.equal(settings.providers.length, 1); assert.equal(settings.defaultModel!.model, 'old-model');
    assert.equal(getModelConfig(db, 'legacy')!.apiKey, 'legacy-key');
    assert.equal(getModelConfig(db, 'legacy')!.baseUrl, 'https://legacy.example/v1');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='model_configs'").get(), undefined);
    db.close(); db = openDatabase(path); assert.deepEqual(getSettings(db, 'legacy'), settings);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); assert.ok(directory.startsWith(root + sep)); rmSync(directory, { recursive: true }); }
});

test('默认切换覆盖所有会话新任务，排队及授权等待中的模型地址和密钥保持不变，同键不重放', async () => {
  const root = resolve('data'); mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'model-task-'));
  writeFileSync(join(directory, 'file.txt'), 'original');
  const requests: { url: string; model: string; key: string }[] = [];
  const upstream = createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part;
    const body = JSON.parse(text); requests.push({ url: request.url!, model: body.model, key: request.headers.authorization ?? '' });
    const delta = requests.length === 1 ? { tool_calls: [{ index: 0, id: 'overwrite', type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: 'file.txt', content: 'changed' }) } }] } : { content: '完成' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const address = upstream.address(); assert.ok(address && typeof address === 'object');
  const f = await fixture(undefined, directory); const userId = String(f.db.prepare('SELECT id FROM users').get()!.id);
  const aInput = { name: '甲', baseUrl: `http://127.0.0.1:${address.port}/a`, models: ['a1', 'a2'], apiKey: 'key-a' };
  try {
    const a = saveProvider(f.db, userId, aInput).id;
    const b = saveProvider(f.db, userId, { ...aInput, name: '乙', baseUrl: `http://127.0.0.1:${address.port}/b`, models: ['b1', 'b2'], apiKey: 'key-b' }).id;
    setDefault(f.db, userId, { providerId: a, model: 'a1' });
    const taskId = f.tasks.create(userId, f.conversationId, '覆盖', 'first');
    // 同一同步调用栈更新，确保任务尚未开始运行也不会读到新配置。
    setDefault(f.db, userId, { providerId: b, model: 'b1' });
    saveProvider(f.db, userId, { ...aInput, baseUrl: `http://127.0.0.1:${address.port}/changed`, apiKey: 'changed-key' }, a);
    await waitFor(() => f.tasks.get(taskId, userId).status === 'waiting_approval');
    deleteProvider(f.db, userId, a);
    const tool = f.db.prepare('SELECT id,arguments_digest FROM tool_calls WHERE task_id=?').get(taskId)!;
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/tool-calls/${tool.id}/decision`, headers: f.headers, payload: { approved: false, argumentsDigest: tool.arguments_digest } })).statusCode, 200);
    await waitFor(() => !f.tasks.isActive(taskId));
    assert.equal(f.tasks.get(taskId, userId).status, 'succeeded');
    assert.deepEqual(requests.slice(0, 2), Array(2).fill({ url: '/a/chat/completions', model: 'a1', key: 'Bearer key-a' }));
    const taskResponse = await f.app.inject({ url: `/api/tasks/${taskId}`, headers: f.headers });
    assert.deepEqual(JSON.parse(taskResponse.json().model_snapshot), { providerId: a, providerName: '甲', model: 'a1' });
    assert.ok(!taskResponse.body.includes('key-a'));
    assert.equal(f.tasks.create(userId, f.conversationId, '覆盖', 'first'), taskId); assert.equal(requests.length, 2);
    const next = f.tasks.create(userId, f.conversationId, '同一会话', 'second'); await waitFor(() => !f.tasks.isActive(next));
    assert.deepEqual(requests.at(-1), { url: '/b/chat/completions', model: 'b1', key: 'Bearer key-b' });
    setDefault(f.db, userId, { providerId: b, model: 'b2' });
    const conversation = (await f.app.inject({ method: 'POST', url: '/api/conversations', headers: f.headers, payload: { title: '另一会话' } })).json();
    const last = f.tasks.create(userId, conversation.id, '另一会话', 'third'); await waitFor(() => !f.tasks.isActive(last));
    assert.deepEqual(requests.at(-1), { url: '/b/chat/completions', model: 'b2', key: 'Bearer key-b' });
  } finally {
    await f.app.close(); await new Promise<void>((done, reject) => upstream.close(error => error ? reject(error) : done()));
    assert.ok(directory.startsWith(root + sep)); rmSync(directory, { recursive: true });
  }
});
