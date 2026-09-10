import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixture } from './helpers.js';
import { registerFrontend } from '../src/http/frontend.js';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/index.js';

test('同源静态托管公开首页与资源，API 认证和文件边界保持有效', async () => {
  await mkdir(resolve('data'), { recursive: true });
  const root = await mkdtemp(resolve('data/static-test-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<html>测试前端</html>');
  await writeFile(join(root, 'assets/app-123.js'), 'console.log("测试资源")');
  await writeFile(join(root, 'assets/app.js.map'), '不公开源码映射');
  await writeFile(join(root, '.env'), '不公开配置');
  const { app } = await createApp({ ...readConfig({}), databasePath: ':memory:', adminPassword: 'test-password-only-123' });
  registerFrontend(app, root);
  try {
    const home = await app.inject('/');
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /测试前端/);
    assert.equal(home.headers['cache-control'], 'no-store');
    assert.equal((await app.inject({ method: 'HEAD', url: '/' })).statusCode, 200);
    const asset = await app.inject('/assets/app-123.js');
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);
    for (const url of ['/api/auth/me', '/api/conversations', '/api/missing', '/.env', '/assets/../.env', '/assets/%2e%2e%2f.env', '/assets/app.js.map', '/assets/missing.js']) {
      const response = await app.inject(url);
      assert.ok([400, 401, 404].includes(response.statusCode), `${url}: ${response.statusCode}`);
      assert.doesNotMatch(response.body, /不公开|测试前端/);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: { username: 'admin', password: 'test-password-only-123' } })).statusCode, 403);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'http://127.0.0.1:5173' }, payload: { username: 'admin', password: 'test-password-only-123' } });
    assert.equal(login.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie: String(login.headers['set-cookie']).split(';')[0]! } })).statusCode, 200);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('静态托管默认关闭，生产环境继续强制 HTTPS', async () => {
  assert.equal(readConfig({}).serveWeb, false);
  assert.equal(readConfig({ SERVE_WEB: 'true' }).serveWeb, true);
  assert.throws(() => readConfig({ SERVE_WEB: 'yes' }));
  assert.throws(() => readConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://localhost:3000' }));
  assert.equal(readConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://example.com' }).secureCookie, true);
  const { app } = await fixture();
  try { assert.equal((await app.inject('/')).statusCode, 401); } finally { await app.close(); }
});
