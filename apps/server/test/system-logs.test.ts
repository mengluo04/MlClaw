import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { formatSystemTime } from '../src/time.js';

test('系统日志历史、筛选、设置并发、归属与脱敏', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject('/api/system-logs')).statusCode, 401);
    const settings = (await f.app.inject({ url: '/api/system-log-settings', headers: f.headers })).json();
    assert.equal(settings.retentionDays, 7); assert.equal(settings.version, 1);
    const cookieOnly = { cookie: f.headers.cookie };
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/system-log-settings', headers: cookieOnly, payload: { retentionDays: 14, expectedVersion: 1 } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/system-log-settings', headers: f.headers, payload: { retentionDays: 31, expectedVersion: 1 } })).statusCode, 400);
    const updated = (await f.app.inject({ method: 'PUT', url: '/api/system-log-settings', headers: f.headers, payload: { retentionDays: 14, expectedVersion: 1 } })).json();
    assert.equal(updated.retentionDays, 14); assert.equal(updated.version, 2);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/system-log-settings', headers: f.headers, payload: { retentionDays: 3, expectedVersion: 1 } })).statusCode, 409);

    const userId = String(f.db.prepare('SELECT id FROM users LIMIT 1').get()!.id);
    f.logs.record(userId, { level: 'error', source: 'channel', event: 'channel.test_failed', message: '异常\n消息', entity: { type: 'channel', id: 'channel-one' }, metadata: { channelKind: 'weixin', statusCode: 502, secret: 'never-store-this' } as Record<string, string | number> });
    const page = (await f.app.inject({ url: '/api/system-logs?level=error&source=channel', headers: f.headers })).json();
    assert.equal(page.items.length, 1); assert.equal(page.items[0].event, 'channel.test_failed');
    assert.equal(page.items[0].message, '异常 消息');
    assert.deepEqual(page.items[0].metadata, { channelKind: 'weixin', statusCode: 502 });
    assert.ok(!JSON.stringify(page).includes('never-store-this'));

    f.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('other-log-user', 'other-log-user', 'hash', formatSystemTime());
    f.logs.record('other-log-user', { level: 'error', source: 'system', event: 'system.other_failed', message: '其他用户日志' });
    assert.ok(!(await f.app.inject({ url: '/api/system-logs', headers: f.headers })).body.includes('其他用户日志'));
  } finally { await f.app.close(); }
});

test('系统日志按时间和容量清理，日志写入故障不抛出', async () => {
  const f = await fixture();
  try {
    const userId = String(f.db.prepare('SELECT id FROM users LIMIT 1').get()!.id);
    f.db.prepare('UPDATE system_log_settings SET retention_days=1 WHERE user_id=?').run(userId);
    f.db.prepare("INSERT INTO system_logs(user_id,level,source,event,message,created_at) VALUES(?,'info','system','system.old','旧日志',?)").run(userId, formatSystemTime(new Date(Date.now() - 2 * 86400000)));
    f.logs.cleanup(userId);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM system_logs WHERE event='system.old'").get()!.n, 0);
    const insert = f.db.prepare("INSERT INTO system_logs(user_id,level,source,event,message,created_at) VALUES(?,'info','system','system.bulk','批量日志',?)");
    f.db.exec('BEGIN IMMEDIATE'); try { for (let i = 0; i < 20005; i++) insert.run(userId, formatSystemTime()); f.db.exec('COMMIT'); } catch (error) { f.db.exec('ROLLBACK'); throw error; }
    f.logs.cleanup(userId);
    assert.ok(Number(f.db.prepare('SELECT COUNT(*) AS n FROM system_logs WHERE user_id=?').get(userId)!.n) <= 20000);
    f.db.exec('DROP TABLE system_logs');
    assert.doesNotThrow(() => f.logs.record(userId, { level: 'error', source: 'system', event: 'system.write_test', message: '写入降级测试' }));
  } finally { await f.app.close(); }
});

test('系统日志 SSE 从游标补发并使用稳定事件 ID', async () => {
  const f = await fixture();
  try {
    const initial = (await f.app.inject({ url: '/api/system-logs', headers: f.headers })).json();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await fetch(`${address}/api/system-logs/stream?after=invalid`, { headers: { cookie: f.headers.cookie } })).status, 400);
    const controller = new AbortController();
    const response = await fetch(`${address}/api/system-logs/stream?after=${initial.latestId}`, { headers: { cookie: f.headers.cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const userId = String(f.db.prepare('SELECT id FROM users LIMIT 1').get()!.id);
    f.logs.record(userId, { level: 'warning', source: 'system', event: 'system.live_test', message: '实时日志测试' });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let body = '';
    const deadline = Date.now() + 3000;
    while (!body.includes('system.live_test') && Date.now() < deadline) {
      const result = await reader.read(); if (result.done) break; body += decoder.decode(result.value);
    }
    assert.match(body, /event: log\.created/); assert.match(body, /id: \d+/); assert.match(body, /实时日志测试/);
    const second = await fetch(`${address}/api/system-logs/stream?after=${initial.latestId}`, { headers: { cookie: f.headers.cookie }, signal: controller.signal });
    assert.equal(second.status, 200);
    const third = await fetch(`${address}/api/system-logs/stream?after=${initial.latestId}`, { headers: { cookie: f.headers.cookie } });
    assert.equal(third.status, 429);
    f.db.prepare('DELETE FROM sessions').run();
    let ended = false; const endDeadline = Date.now() + 2000;
    while (!ended && Date.now() < endDeadline) ended = (await reader.read()).done;
    assert.equal(ended, true);
    controller.abort(); await reader.cancel().catch(() => {}); await second.body?.cancel().catch(() => {});
  } finally { await f.app.close(); }
});
