import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { formatSystemTime, parseSystemTime, serverTimezone } from '../src/time.js';
import { fixture, waitFor } from './helpers.js';

const pattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

test('系统时间格式在不同时区、跨日和午夜保持固定格式并可解析', () => {
  for (const [timezone, expected] of [['Asia/Shanghai', '2027-01-01 00:00:00'], ['UTC', '2026-12-31 16:00:00'], ['America/New_York', '2026-12-31 11:00:00']]) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import {formatSystemTime,parseSystemTime} from './apps/server/src/time.ts';
      const value = formatSystemTime(new Date('2026-12-31T16:00:00.999Z'));
      console.log(JSON.stringify([value,parseSystemTime(value)]));
    `], { cwd: resolve('.'), env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [expected, Date.parse('2026-12-31T16:00:00Z')]);
  }
});

test('第 9 版迁移转换旧 UTC 时间，保留空值、正文、手动键，重开不重复转换', () => {
  const root = resolve('data'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'local-time-')); const path = join(directory, 'test.sqlite');
  let db = openDatabase(path);
  try {
    const old = '2026-09-09T23:59:59.123Z'; const expected = formatSystemTime(new Date(old));
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('u', 'u', 'hash', old);
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('token', 'u', old);
    db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run('c', 'u', old, old);
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('m', 'c', 'user', old, old);
    db.prepare("INSERT INTO schedules (id,user_id,name,kind,content,cron,enabled,version,next_run_at,timezone,created_at,updated_at) VALUES ('s','u','s','reminder','text','* * * * *',1,1,?,?,?,?)").run(old, serverTimezone(), old, old);
    for (const source of ['cron', 'manual']) db.prepare("INSERT INTO schedule_occurrences (id,schedule_id,user_id,trigger_key,source,scheduled_at,snapshot,status,created_at) VALUES (?,'s','u',?,?,?,'{}','succeeded',?)").run(source, `${source}:${old}`, source, old, old);
    db.exec('DROP TABLE system_log_settings; DROP TABLE system_logs; DELETE FROM schema_migrations WHERE version=14; DROP TABLE schedule_deliveries; ALTER TABLE schedule_occurrences DROP COLUMN delivery_target; ALTER TABLE schedules DROP COLUMN delivery_target; ALTER TABLE channel_accounts DROP COLUMN binding_version; DELETE FROM schema_migrations WHERE version=13; DROP TABLE task_skill_loads; DROP TABLE task_skills; DROP TABLE skills; DROP TRIGGER summary_message_update; DROP TRIGGER summary_message_delete; DROP TABLE conversation_context; DROP INDEX tasks_user_history; ALTER TABLE tasks DROP COLUMN kind; ALTER TABLE tasks DROP COLUMN context_snapshot; DROP TABLE web_settings; ALTER TABLE tasks DROP COLUMN web_snapshot; DELETE FROM schema_migrations WHERE version>=9'); db.close(); db = openDatabase(path);
    assert.equal(db.prepare('SELECT created_at FROM users').get()!.created_at, expected);
    assert.equal(db.prepare('SELECT expires_at FROM sessions').get()!.expires_at, expected);
    const message = db.prepare('SELECT * FROM messages').get()!;
    assert.equal(message.content, old); assert.equal(message.created_at, expected);
    assert.equal(db.prepare('SELECT next_run_at FROM schedules').get()!.next_run_at, expected);
    const cron = db.prepare("SELECT * FROM schedule_occurrences WHERE id='cron'").get()!;
    assert.equal(cron.trigger_key, `cron:${Date.parse(old)}`); assert.equal(cron.scheduled_at, expected); assert.equal(cron.finished_at, null);
    assert.equal(db.prepare("SELECT trigger_key FROM schedule_occurrences WHERE id='manual'").get()!.trigger_key, `manual:${old}`);
    db.close(); db = openDatabase(path);
    assert.equal(db.prepare('SELECT created_at FROM users').get()!.created_at, expected);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, 14);
  } finally { db.close(); assert.ok(directory.startsWith(root + '/') || directory.startsWith(root + '\\')); rmSync(directory, { recursive: true }); }
});

test('HTTP、任务、消息、SSE 与运行上下文均返回系统本地秒格式', async () => {
  let runtime: { now: string; timezone: string } | undefined;
  const f = await fixture({ async *stream(messages) {
    runtime = JSON.parse(messages.find(message => message.content.startsWith('运行信息：'))!.content.split('\n')[1]!);
    yield { type: 'delta', text: '模拟回复' }; yield { type: 'complete', calls: [] };
  } });
  try {
    const conversation = (await f.app.inject({ url: `/api/conversations/${f.conversationId}`, headers: f.headers })).json();
    assert.match(conversation.created_at, pattern);
    const response = await f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers, payload: { content: '时间测试', idempotencyKey: 'time-test' } });
    assert.equal(response.statusCode, 202); const id = response.json().taskId;
    await waitFor(() => !f.tasks.isActive(id));
    const task = (await f.app.inject({ url: `/api/tasks/${id}`, headers: f.headers })).json();
    assert.match(task.created_at, pattern); assert.match(task.finished_at, pattern);
    assert.equal(runtime!.now, task.created_at); assert.equal(runtime!.timezone, serverTimezone());
    const messages = (await f.app.inject({ url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers })).json().messages;
    assert.equal(messages.length, 2); for (const message of messages) assert.match(message.created_at, pattern);
    const events = await f.app.inject({ url: `/api/tasks/${id}/events`, headers: f.headers });
    const frames = events.body.split('\n').filter(line => line.startsWith('data: '));
    assert.ok(frames.length > 0); for (const frame of frames) assert.match(JSON.parse(frame.slice(6)).createdAt, pattern);
    const expiry = String(f.db.prepare('SELECT expires_at FROM sessions').get()!.expires_at);
    assert.match(expiry, pattern); assert.ok(parseSystemTime(expiry) > Date.now());
  } finally { await f.app.close(); }
});
