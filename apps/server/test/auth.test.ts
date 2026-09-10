import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { openDatabase, transaction } from '../src/db/index.js';
import { readConfig, type Config } from '../src/config/index.js';
import { assertPrivateStorage } from '../src/config/paths.js';

const password = 'test-password-only-123';
const config: Config = { host: '127.0.0.1', port: 3000, databasePath: ':memory:', origin: 'http://127.0.0.1:5173', secureCookie: false, adminUsername: 'admin', adminPassword: password, sessionSeconds: 86400 };
const origin = config.origin;

test('数据库迁移可重复、事务回滚、外键约束和持久化', () => {
  const root = resolve('data');
  // 所有测试磁盘写入均在项目内。
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'migration-'));
  const file = join(directory, 'test.sqlite');
  try {
    let db = openDatabase(file);
    assert.throws(() => openDatabase(file), /已有 MlClaw 实例/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, 14);
    assert.throws(() => transaction(db, () => { db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('u', 'u', 'hash', 'now'); throw new Error('rollback'); }));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 0);
    assert.throws(() => db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s', 'missing', 'later'));
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('u', 'u', 'hash', 'now'); db.close();
    db = openDatabase(file);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, 14);
    db.close();
  } finally { assert.ok(directory.startsWith(root + '\\') || directory.startsWith(root + '/')); rmSync(directory, { recursive: true }); }
});

test('管理员必须显式初始化，生产来源要求 HTTPS', async () => {
  await assert.rejects(createApp({ ...config, adminPassword: undefined }), /ADMIN_PASSWORD/);
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /HTTPS/);
  assert.throws(() => readConfig({ LOG_LEVEL: 'debug' }), /LOG_LEVEL/);
  assert.throws(() => assertPrivateStorage(resolve('data'), resolve('data/secret.sqlite')), /数据库/);
  assert.throws(() => assertPrivateStorage(resolve('.'), ':memory:'), /环境配置/);
});

test('不同进程不能同时打开数据库，进程终止后租约自动释放', async () => {
  const root = resolve('data'); mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'lease-'));
  const file = join(directory, 'test.sqlite');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import { openDatabase } from './apps/server/src/db/index.ts'; openDatabase(process.argv[1]); process.stdout.write('ready'); setInterval(() => {}, 1000);", file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false; child.once('exit', () => { exited = true; });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'error').then(([error]) => { throw error; }), once(child, 'exit').then(() => { throw new Error('租约测试子进程提前退出'); })]);
    assert.throws(() => openDatabase(file), /已有 MlClaw 实例/);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    const db = openDatabase(file); db.close();
  } finally { if (!exited) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } assert.ok(directory.startsWith(root)); rmSync(directory, { recursive: true }); }
});

test('认证、CSRF、会话退出与过期、配置脱敏', async () => {
  const { app, db } = await createApp(config);
  try {
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    for (const url of ['/api/auth/me', '/api/settings/models', '/api/tasks/unknown/events']) assert.equal((await app.inject(url)).statusCode, 401);
    for (const headers of [{}, { origin: 'https://evil.example' }]) assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: 'admin', password } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password: 'wrong' } })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password } });
    assert.equal(login.statusCode, 200);
    const setCookie = String(login.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    const headers = { cookie, origin };
    assert.equal((await app.inject({ url: '/api/auth/me', headers })).json().username, 'admin');
    assert.notEqual(db.prepare('SELECT password_hash FROM users').get()!.password_hash, password);
    assert.ok(!String(db.prepare('SELECT token_hash FROM sessions').get()!.token_hash).includes(cookie.split('=')[1]!));
    const secret = 'test-secret-never-return';
    const created = await app.inject({ method: 'POST', url: '/api/settings/providers', headers, payload: { name: '测试', baseUrl: 'https://model.example/v1', models: ['test'], apiKey: secret } });
    assert.equal(created.statusCode, 200); const providerId = created.json().id;
    const settings = await app.inject({ url: '/api/settings/models', headers });
    assert.equal(settings.json().providers[0].hasApiKey, true); assert.ok(!settings.body.includes(secret));
    assert.equal((await app.inject({ method: 'PUT', url: `/api/settings/providers/${providerId}`, headers, payload: { baseUrl: 'https://other.example/v1', name: '测试', models: ['test'] } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/settings/models', headers })).json().providers[0].hasApiKey, false);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/settings/providers/${providerId}`, headers, payload: { baseUrl: 'https://secret@example.com/v1', name: '测试', models: ['test'] } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/auth/me', headers })).statusCode, 401);
    const next = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password } });
    db.prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie: String(next.headers['set-cookie']).split(';')[0]! } })).statusCode, 401);
  } finally { await app.close(); }
});

test('服务重启保留配置和管理员，生产 Cookie 启用 Secure', async () => {
  const root = resolve('data'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'restart-'));
  const persistent = { ...config, databasePath: join(directory, 'test.sqlite'), secureCookie: true };
  let instance = await createApp(persistent);
  try {
    const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password } });
    assert.match(String(login.headers['set-cookie']), /; Secure/);
    const headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]! };
    await instance.app.inject({ method: 'POST', url: '/api/settings/providers', headers, payload: { name: '持久配置', baseUrl: 'https://model.example/v1', models: ['saved'], apiKey: 'secret' } });
    await instance.app.close();
    instance = await createApp({ ...persistent, adminPassword: undefined });
    const settings = await instance.app.inject({ url: '/api/settings/models', headers });
    assert.deepEqual(settings.json().providers[0], { id: settings.json().providers[0].id, name: '持久配置', baseUrl: 'https://model.example/v1', models: ['saved'], hasApiKey: true });
    assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 1);
  } finally { await instance.app.close(); assert.ok(directory.startsWith(root)); rmSync(directory, { recursive: true }); }
});

test('登录频率限制在验证密码前生效', async () => {
  const { app } = await createApp(config);
  try {
    for (let i = 0; i < 5; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password: 'wrong' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password } })).statusCode, 429);
  } finally { await app.close(); }
});

test('真实 HTTP 连接测试使用保存配置且不泄露上游响应', async () => {
  let status = 401;
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-upstream-key');
    response.writeHead(status, { 'content-type': 'application/json' }); response.end('{"error":"test-upstream-key"}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); assert.ok(address && typeof address === 'object');
  const { app } = await createApp(config);
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password } });
    const headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]! };
    const created = await app.inject({ method: 'POST', url: '/api/settings/providers', headers, payload: { baseUrl: `http://127.0.0.1:${address.port}/v1`, name: '测试', models: ['test'], apiKey: 'test-upstream-key' } });
    const providerId = created.json().id;
    const result = await app.inject({ method: 'POST', url: `/api/settings/providers/${providerId}/test`, headers, payload: { model: 'test' } });
    assert.equal(result.statusCode, 502); assert.ok(!result.body.includes('test-upstream-key'));
    status = 200;
    const malformedSuccess = await app.inject({ method: 'POST', url: `/api/settings/providers/${providerId}/test`, headers, payload: { model: 'test' } });
    assert.equal(malformedSuccess.statusCode, 502); assert.ok(!malformedSuccess.body.includes('test-upstream-key'));
  } finally { await app.close(); await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())); }
});
