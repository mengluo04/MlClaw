import { formatSystemTime } from '../src/time.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Schedule, ScheduleInput, ScheduleOccurrence } from '@mlclaw/shared';
import type { Provider } from '../src/providers/types.js';
import { cronPreview, serverTimezone } from '../src/schedules/cron.js';
import { ScheduleManager } from '../src/schedules/manager.js';
import { TaskManager } from '../src/tasks/manager.js';
import { openDatabase, transaction } from '../src/db/index.js';
import { fixture, waitFor } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const input: ScheduleInput = { name: '测试定时计划', kind: 'reminder', content: '记得休息', cron: '* * * * *', enabled: true };
const echo: Provider = { async *stream() { yield { type: 'delta', text: '模拟定时回复' }; yield { type: 'complete', calls: [] }; } };
async function setup(provider: Provider | undefined = echo, workspace?: string) {
  let now = new Date('2026-09-09T00:00:00.000Z');
  const f = await fixture(provider, workspace, undefined, { clock: () => now }); f.schedules.close();
  const userId = String(f.db.prepare('SELECT id FROM users').get()!.id);
  return { ...f, userId, setTime(value: string) { now = new Date(value); }, advance(ms: number) { now = new Date(now.getTime() + ms); } };
}
async function create(f: Fixture, changes: Partial<ScheduleInput> = {}) {
  const response = await f.app.inject({ method: 'POST', url: '/api/schedules', headers: f.headers, payload: { ...input, ...changes } });
  assert.equal(response.statusCode, 201, response.body); return response.json<Schedule>();
}
async function run(f: Fixture, schedule: Schedule, key = 'manual-key') {
  const response = await f.app.inject({ method: 'POST', url: `/api/schedules/${schedule.id}/run`, headers: f.headers, payload: { idempotencyKey: key, expectedVersion: schedule.version } });
  assert.equal(response.statusCode, 202, response.body); return response.json<ScheduleOccurrence>();
}

test('Cron 只接受确定的五段数字表达式，按指定服务器时区预览', () => {
  const now = new Date('2026-09-09T00:00:00Z');
  assert.equal(cronPreview(' 0  9 * * * ', now, 'Asia/Shanghai').nextRuns[0], '2026-09-09 09:00:00');
  assert.equal(cronPreview('0 9 * * 1-5', now, 'UTC').nextRuns[0], '2026-09-09 09:00:00');
  assert.equal(cronPreview('*/15 9-10 * * 1,3,5', now, 'Asia/Shanghai').nextRuns.length, 5);
  for (const cron of ['* * * * * *', '@daily', 'H * * * *', '0 25 * * *', '*/0 * * * *', '0 0 30 2 *', '', '0 0 * JAN *', '0 0 L * *']) assert.throws(() => cronPreview(cron, now));
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import {cronPreview,serverTimezone} from './apps/server/src/schedules/cron.ts'; console.log(JSON.stringify({zone:serverTimezone(),...cronPreview('0 9 * * *',new Date('2026-09-09T00:00:00Z'))}));"], { cwd: resolve('.'), env: { ...process.env, TZ: 'Asia/Shanghai' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).nextRuns[0], '2026-09-09 09:00:00');
});

test('计划接口认证、来源、运行时校验、归属与版本冲突', async () => {
  const f = await setup();
  try {
    assert.equal((await f.app.inject({ url: '/api/schedules' })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/schedules', headers: { cookie: f.headers.cookie, origin: 'https://wrong.example' }, payload: input })).statusCode, 403);
    for (const patch of [{ cron: '* * * * * *' }, { timezone: 'UTC' }, { kind: 'command' }, { enabled: 'true' }, { content: ' ' }]) {
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/schedules', headers: f.headers, payload: { ...input, ...patch } })).statusCode, 400);
    }
    const plan = await create(f);
    assert.equal((await f.app.inject({ url: '/api/schedules', headers: f.headers })).json().timezone, serverTimezone());
    const edited = await f.app.inject({ method: 'PUT', url: `/api/schedules/${plan.id}`, headers: f.headers, payload: { ...input, expectedVersion: 1, enabled: false } });
    assert.equal(edited.statusCode, 200); assert.equal(edited.json().nextRunAt, null);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/schedules/${plan.id}`, headers: f.headers, payload: { ...input, expectedVersion: 1 } })).statusCode, 409);
    f.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('other', 'other', 'hash', 'now');
    const other = f.schedules.store.save('other', input);
    for (const method of ['PUT', 'DELETE', 'POST'] as const) {
      const response = await f.app.inject({ method, url: `/api/schedules/${other.id}${method === 'POST' ? '/run' : ''}`, headers: f.headers,
        payload: method === 'PUT' ? { ...input, expectedVersion: 1 } : method === 'DELETE' ? { expectedVersion: 1 } : { expectedVersion: 1, idempotencyKey: 'foreign' } });
      assert.equal(response.statusCode, 404);
    }
    const foreignRun = f.schedules.runNow(other.id, 'other', 'foreign', 1); f.schedules.tick();
    for (const operation of ['cancel', 'read']) assert.equal((await f.app.inject({ method: 'POST', url: `/api/schedule-occurrences/${foreignRun.id}/${operation}`, headers: f.headers })).statusCode, 404);
    assert.equal((await f.app.inject({ url: `/api/schedule-occurrences?scheduleId=${other.id}`, headers: f.headers })).json().occurrences.length, 0);
    assert.equal((await f.app.inject({ url: '/api/schedule-occurrences?before=-1', headers: f.headers })).statusCode, 400);
  } finally { await f.app.close(); }
});

test('批量启停删除校验全部版本后原子执行并取消未启动实例', async () => {
  const f = await setup();
  try {
    let first = await create(f, { name: '批量计划一' });
    let second = await create(f, { name: '批量计划二', enabled: false });
    const pending = await run(f, first, 'batch-pending');
    const batch = (operation: 'enable' | 'disable' | 'delete', items: Array<{ id: string; expectedVersion: number }>) =>
      f.app.inject({ method: 'POST', url: '/api/schedules/batch', headers: f.headers, payload: { operation, items } });
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/schedules/batch', headers: { origin: f.headers.origin }, payload: { operation: 'disable', items: [{ id: first.id, expectedVersion: first.version }] } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/schedules/batch', headers: { cookie: f.headers.cookie, origin: 'https://wrong.example' }, payload: { operation: 'disable', items: [{ id: first.id, expectedVersion: first.version }] } })).statusCode, 403);
    assert.equal((await batch('disable', [])).statusCode, 400);
    const disabled = await batch('disable', [{ id: first.id, expectedVersion: first.version }, { id: second.id, expectedVersion: second.version }]);
    assert.equal(disabled.statusCode, 200, disabled.body); assert.equal(disabled.json().updated, 1);
    first = f.schedules.store.get(first.id, f.userId); second = f.schedules.store.get(second.id, f.userId);
    assert.equal(first.enabled, false); assert.equal(first.version, 2); assert.equal(second.version, 1);
    assert.equal(f.schedules.store.occurrence(pending.id, f.userId).status, 'cancelled');
    const conflict = await batch('enable', [{ id: first.id, expectedVersion: first.version }, { id: second.id, expectedVersion: 99 }]);
    assert.equal(conflict.statusCode, 409); assert.equal(f.schedules.store.get(first.id, f.userId).version, 2);
    const enabled = await batch('enable', [{ id: first.id, expectedVersion: first.version }, { id: second.id, expectedVersion: second.version }]);
    assert.equal(enabled.statusCode, 200, enabled.body); assert.equal(enabled.json().updated, 2);
    first = f.schedules.store.get(first.id, f.userId); second = f.schedules.store.get(second.id, f.userId);
    assert.equal(first.enabled, true); assert.ok(first.nextRunAt); assert.equal(second.enabled, true); assert.ok(second.nextRunAt);
    f.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('batch-other', 'batch-other', 'hash', 'now');
    const other = f.schedules.store.save('batch-other', { ...input, name: '其他用户计划' });
    const foreign = await batch('disable', [{ id: first.id, expectedVersion: first.version }, { id: other.id, expectedVersion: other.version }]);
    assert.equal(foreign.statusCode, 404); assert.equal(f.schedules.store.get(first.id, f.userId).version, first.version);
    const removed = await batch('delete', [{ id: first.id, expectedVersion: first.version }, { id: second.id, expectedVersion: second.version }]);
    assert.equal(removed.statusCode, 200, removed.body); assert.equal(removed.json().updated, 2);
    assert.equal(f.schedules.store.list(f.userId).length, 0);
  } finally { await f.app.close(); }
});

test('重复扫描只有一次提醒，手动运行幂等且不改变 Cron 时间，已读状态持久化', async () => {
  const f = await setup();
  try {
    const plan = await create(f); f.advance(60000); f.schedules.tick(); f.schedules.tick();
    let records = f.schedules.store.history(f.userId).occurrences;
    assert.equal(records.length, 1); assert.equal(records[0]!.status, 'succeeded');
    const next = f.schedules.store.get(plan.id, f.userId).nextRunAt;
    const manual = await run(f, plan); f.schedules.tick();
    assert.equal((await run(f, plan)).id, manual.id);
    assert.equal(f.schedules.store.get(plan.id, f.userId).nextRunAt, next);
    assert.equal(f.schedules.store.unread(f.userId), 2);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/schedule-occurrences/${manual.id}/read`, headers: f.headers })).statusCode, 200);
    assert.equal(f.schedules.store.unread(f.userId), 1);
    const recovered = new ScheduleManager(f.db, f.tasks, { clock: f.schedules.store.clock });
    records = recovered.store.history(f.userId).occurrences;
    assert.equal(records.length, 2); assert.ok(records.find(r => r.id === manual.id)!.readAt);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 0);
  } finally { await f.app.close(); }
});

test('编辑、停用、删除取消待执行实例；旧手动请求保留原快照、不重复执行', async () => {
  const f = await setup();
  try {
    let plan = await create(f, { kind: 'agent' });
    const first = await run(f, plan);
    plan = f.schedules.store.save(f.userId, { ...input, enabled: false }, plan.id, 1);
    assert.equal(f.schedules.store.occurrence(first.id, f.userId).status, 'cancelled');
    assert.equal(f.schedules.store.occurrence(first.id, f.userId).snapshot.kind, 'agent');
    assert.equal(f.schedules.runNow(plan.id, f.userId, 'manual-key', 1).id, first.id);
    assert.throws(() => f.schedules.runNow(plan.id, f.userId, 'manual-key', 2), /幂等键/);
    const second = await run(f, plan, 'second');
    f.schedules.store.remove(plan.id, f.userId, 2);
    assert.equal(f.schedules.store.occurrence(second.id, f.userId).status, 'cancelled');
    assert.equal(f.schedules.store.list(f.userId).length, 0);
    assert.equal(f.schedules.runNow(plan.id, f.userId, 'second', 2).id, second.id);
    assert.throws(() => f.schedules.runNow(plan.id, f.userId, 'new', 2), /不存在/);
    f.schedules.tick(); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 0);
  } finally { await f.app.close(); }
});

test('AI 复用任务、默认模型快照、独立会话与只读定义，完成后重复请求不重跑', async () => {
  let calls = 0;
  const provider: Provider = { async *stream(_messages, tools) {
    calls++; assert.deepEqual(tools.map(t => t.function.name).sort(), ['list_directory', 'read_skill', 'read_skill_resource', 'read_task', 'read_text', 'search_memories', 'search_skills', 'search_tasks', 'search_text']);
    yield { type: 'delta', text: '模拟执行成功' }; yield { type: 'complete', calls: [] };
  } };
  const f = await setup(provider);
  try {
    const p = (await f.app.inject({ method: 'POST', url: '/api/settings/providers', headers: f.headers, payload: { name: '定时模拟模型', baseUrl: 'https://example.test/v1', models: ['test-model'], apiKey: 'private-key' } })).json();
    const defaultResponse = await f.app.inject({ method: 'PUT', url: '/api/settings/model-default', headers: f.headers, payload: { providerId: p.id, model: 'test-model' } });
    assert.equal(defaultResponse.statusCode, 200, defaultResponse.body);
    const plan = await create(f, { kind: 'agent' }); const first = await run(f, plan); f.schedules.tick();
    await waitFor(() => !f.tasks.isBusy());
    const done = f.schedules.store.occurrence(first.id, f.userId); assert.equal(done.status, 'succeeded');
    const task = f.tasks.get(done.taskId!, f.userId);
    assert.equal(task.tool_policy, 'readonly'); assert.equal(JSON.parse(String(task.model_snapshot)).model, 'test-model');
    assert.ok(!String(task.model_snapshot).includes('private-key'));
    assert.notEqual(done.conversationId, f.conversationId);
    assert.equal((await run(f, plan)).id, first.id); f.schedules.tick(); assert.equal(calls, 1);
    const second = await run(f, plan, 'new'); f.schedules.tick(); await waitFor(() => !f.tasks.isBusy());
    assert.notEqual(f.schedules.store.occurrence(second.id, f.userId).conversationId, done.conversationId);
    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/conversations/${done.conversationId}`, headers: f.headers })).statusCode, 200);
    assert.equal(f.schedules.store.occurrence(first.id, f.userId).status, 'succeeded');
    assert.equal(f.schedules.store.occurrence(first.id, f.userId).conversationId, null);
  } finally { await f.app.close(); }
});

test('定时模型伪造写文件与命令请求被拒绝，执行入口也重新检查权限', async () => {
  mkdirSync(resolve('data'), { recursive: true }); const root = mkdtempSync(resolve('data/schedules-tools-'));
  const provider: Provider = { async *stream() { yield { type: 'complete', calls: [{ id: 'bad', type: 'function', function: { name: 'write_text', arguments: '{"path":"new.txt","content":"bad"}' } }] }; } };
  const f = await setup(provider, root);
  try {
    const plan = await create(f, { kind: 'agent' }); const occurrence = await run(f, plan); f.schedules.tick(); await waitFor(() => !f.tasks.isBusy());
    const result = f.schedules.store.occurrence(occurrence.id, f.userId);
    assert.equal(result.status, 'failed'); assert.match(result.reason!, /仅允许读取/); assert.equal(existsSync(join(root, 'new.txt')), false);
    assert.throws(() => f.tasks.registry.prepare({ id: 'bad', type: 'function', function: { name: 'execute_command', arguments: '{}' } }, 'readonly'), /禁止/);
    const prepared = f.tasks.registry.prepare({ id: 'bad', type: 'function', function: { name: 'write_text', arguments: '{"path":"new.txt","content":"bad"}' } });
    await assert.rejects(f.tasks.registry.execute(prepared, new AbortController().signal, 'readonly'), /禁止/);
    writeFileSync(join(root, 'read.txt'), '可读');
    const read = f.tasks.registry.prepare({ id: 'read', type: 'function', function: { name: 'read_text', arguments: '{"path":"read.txt"}' } }, 'readonly');
    assert.match(await f.tasks.registry.execute(read, new AbortController().signal, 'readonly'), /可读/);
    const outside = f.tasks.registry.prepare({ id: 'read', type: 'function', function: { name: 'read_text', arguments: '{"path":"../secret.txt"}' } }, 'readonly');
    await assert.rejects(f.tasks.registry.execute(outside, new AbortController().signal, 'readonly'));
  } finally { await f.app.close(); assert.ok(root.startsWith(resolve('data') + '/') || root.startsWith(resolve('data') + '\\')); rmSync(root, { recursive: true }); }
});

test('全局忙碌时等待、同计划不重叠、10 分钟超时，提醒不占模型名额', async () => {
  const blocking: Provider = { async *stream(_m, _t, signal) { await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true })); yield { type: 'complete', calls: [] }; } };
  const f = await setup(blocking);
  try {
    const task = f.tasks.create(f.userId, f.conversationId, '占用', 'busy');
    const plan = await create(f, { kind: 'agent' }); const waiting = await run(f, plan); f.schedules.tick();
    assert.equal(f.schedules.store.occurrence(waiting.id, f.userId).status, 'pending');
    assert.throws(() => f.schedules.runNow(plan.id, f.userId, 'another', 1), /已有执行/);
    const reminder = await create(f, { name: '提醒' }); const reminderRun = await run(f, reminder); f.schedules.tick();
    assert.equal(f.schedules.store.occurrence(reminderRun.id, f.userId).status, 'succeeded');
    f.advance(60000); f.schedules.tick();
    assert.ok(f.schedules.store.history(f.userId).occurrences.some(o => o.scheduleId === plan.id && o.reason?.includes('上一执行')));
    f.advance(540000); f.schedules.tick();
    assert.equal(f.schedules.store.occurrence(waiting.id, f.userId).status, 'skipped');
    assert.match(f.schedules.store.occurrence(waiting.id, f.userId).reason!, /10 分钟/);
    f.tasks.cancel(task, f.userId); await waitFor(() => !f.tasks.isBusy());
    const next = await run(f, plan, 'after-idle'); f.schedules.tick();
    assert.equal(f.schedules.store.occurrence(next.id, f.userId).status, 'running');
    f.schedules.store.save(f.userId, { ...input, kind: 'agent', enabled: false }, plan.id, 1);
    assert.equal(f.schedules.store.occurrence(next.id, f.userId).status, 'running');
    f.schedules.cancel(next.id, f.userId); await waitFor(() => !f.tasks.isBusy());
    assert.equal(f.schedules.store.occurrence(next.id, f.userId).status, 'cancelled');
  } finally { await f.app.close(); }
});

test('启动失败回滚独立会话与任务，重复请求不自动重试失败', async () => {
  const f = await setup();
  try {
    f.db.exec("CREATE TRIGGER reject_schedule_task BEFORE UPDATE OF status ON schedule_occurrences WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    const plan = await create(f, { kind: 'agent' }); const occurrence = await run(f, plan); f.schedules.tick();
    assert.equal(f.schedules.store.occurrence(occurrence.id, f.userId).status, 'failed');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get()!.n, 1);
    f.db.exec('DROP TRIGGER reject_schedule_task');
    assert.equal((await run(f, plan)).id, occurrence.id); f.schedules.tick();
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 0);
  } finally { await f.app.close(); }
});

test('服务重启不补跑停机触发、取消未派发执行、提交后未启动任务标为中断', async () => {
  let calls = 0; const provider: Provider = { async *stream() { calls++; yield { type: 'complete', calls: [] }; } };
  const f = await setup(provider);
  try {
    const plan = await create(f, { kind: 'agent' }); const pending = await run(f, plan);
    const other = await create(f, { kind: 'agent', name: '已提交' }); const occurrence = await run(f, other);
    transaction(f.db, () => {
      f.db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run('crash-conversation', f.userId, '崩溃窗口', 'now');
      const prepared = f.tasks.prepare(f.userId, 'crash-conversation', input.content, `schedule:${occurrence.id}`, 'readonly');
      f.db.prepare("UPDATE schedule_occurrences SET task_id=?,conversation_id='crash-conversation',status='running' WHERE id=?").run(prepared.taskId, occurrence.id);
      // 模拟事务已提交、进程尚未 start 就退出。
    });
    f.advance(3 * 86400000);
    const tasks = new TaskManager(f.db, () => provider);
    const recovered = new ScheduleManager(f.db, tasks, { clock: f.schedules.store.clock });
    assert.equal(recovered.store.occurrence(pending.id, f.userId).status, 'cancelled');
    assert.equal(recovered.store.occurrence(occurrence.id, f.userId).status, 'interrupted');
    assert.equal(recovered.store.history(f.userId).occurrences.filter(r => r.status === 'skipped').length, 2);
    const next = recovered.store.get(plan.id, f.userId).nextRunAt!;
    assert.ok(next > formatSystemTime(f.schedules.store.clock()));
    recovered.tick(); assert.equal(calls, 0);
    assert.equal(recovered.runNow(other.id, f.userId, 'manual-key', 1).id, occurrence.id);
    f.setTime(next); recovered.tick(); await waitFor(() => !tasks.isBusy()); assert.equal(calls, 1);
    await tasks.close();
  } finally { await f.app.close(); }
});

test('扫描推进失败整体回滚，时钟回拨不会重复提醒', async () => {
  const f = await setup();
  try {
    const plan = await create(f);
    f.db.exec("CREATE TRIGGER reject_advance BEFORE UPDATE OF next_run_at ON schedules BEGIN SELECT RAISE(ABORT,'test advance'); END;");
    f.advance(60000); assert.throws(() => f.schedules.tick());
    assert.equal(f.schedules.store.history(f.userId).occurrences.length, 0);
    assert.equal(f.schedules.store.get(plan.id, f.userId).nextRunAt, plan.nextRunAt);
    f.db.exec('DROP TRIGGER reject_advance'); f.schedules.tick();
    f.advance(-60000); f.schedules.tick(); f.advance(60000); f.schedules.tick();
    assert.equal(f.schedules.store.history(f.userId).occurrences.length, 1);
    f.advance(86400000); f.schedules.tick();
    assert.equal(f.schedules.store.history(f.userId).occurrences.length, 2);
    assert.equal(f.schedules.store.history(f.userId).occurrences[0]!.status, 'skipped');
  } finally { await f.app.close(); }
});

test('第 8 版迁移保留旧任务，计划和提醒落盘后重开保留', () => {
  mkdirSync(resolve('data'), { recursive: true }); const root = mkdtempSync(resolve('data/schedule-migration-')); const path = join(root, 'db.sqlite');
  let db = openDatabase(path);
  try {
    db.exec('DROP TABLE system_log_settings; DROP TABLE system_logs; DELETE FROM schema_migrations WHERE version=14; DROP TABLE schedule_deliveries; ALTER TABLE schedule_occurrences DROP COLUMN delivery_target; ALTER TABLE schedules DROP COLUMN delivery_target; ALTER TABLE channel_accounts DROP COLUMN binding_version; DELETE FROM schema_migrations WHERE version=13; DROP TABLE task_skill_loads; DROP TABLE task_skills; DROP TABLE skills; DROP TRIGGER summary_message_update; DROP TRIGGER summary_message_delete; DROP TABLE conversation_context; DROP INDEX tasks_user_history; ALTER TABLE tasks DROP COLUMN kind; ALTER TABLE tasks DROP COLUMN context_snapshot; DROP TABLE web_settings; ALTER TABLE tasks DROP COLUMN web_snapshot; DROP TABLE schedule_occurrences; DROP TABLE schedules; ALTER TABLE tasks DROP COLUMN tool_policy; DELETE FROM schema_migrations WHERE version>=8;');
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('u', 'u', 'hash', 'now');
    db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run('c', 'u', '旧会话', 'now');
    db.prepare('INSERT INTO tasks (id,user_id,conversation_id,status,idempotency_key,input,created_at) VALUES (?,?,?,?,?,?,?)').run('t', 'u', 'c', 'succeeded', 'old', '旧任务', 'now');
    db.close(); db = openDatabase(path);
    assert.equal(db.prepare("SELECT tool_policy FROM tasks WHERE id='t'").get()!.tool_policy, 'full');
    const tasks = new TaskManager(db); const schedules = new ScheduleManager(db, tasks);
    const plan = schedules.store.save('u', input); const run = schedules.runNow(plan.id, 'u', 'persist', 1); schedules.tick(); schedules.store.markRead(run.id, 'u');
    db.close(); db = openDatabase(path);
    const restored = new ScheduleManager(db, new TaskManager(db));
    assert.equal(restored.store.list('u').length, 1);
    assert.equal(restored.store.occurrence(run.id, 'u').status, 'succeeded'); assert.ok(restored.store.occurrence(run.id, 'u').readAt);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, 14);
    assert.equal(db.prepare("SELECT input FROM tasks WHERE id='t'").get()!.input, '旧任务');
  } finally { db.close(); assert.ok(root.startsWith(resolve('data') + '\\') || root.startsWith(resolve('data') + '/')); rmSync(root, { recursive: true }); }
});
