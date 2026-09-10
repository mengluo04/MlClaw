import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultAssistant, parseAssistant } from '../src/assistant/config.js';
import { assistantTemplates } from '../src/assistant/templates.js';
import { getAssistant, saveAssistant } from '../src/assistant/store.js';
import { openDatabase } from '../src/db/index.js';
import { fixture } from './helpers.js';

test('配置备份及恢复接口已移除，模板仍可使用且不自动保存', async () => {
  for (const template of assistantTemplates()) assert.deepEqual(parseAssistant(template.config), template.config);
  const f = await fixture();
  try {
    const url = '/api/settings/assistant';
    assert.equal((await f.app.inject({ url: `${url}/templates` })).statusCode, 401);
    assert.equal((await f.app.inject({ url: `${url}/templates`, headers: f.headers })).json().length, 3);
    for (const path of ['export', 'revisions']) assert.equal((await f.app.inject({ url: `${url}/${path}`, headers: f.headers })).statusCode, 404);
    for (const path of ['import-preview', 'revisions/old/restore']) assert.equal((await f.app.inject({ method: 'POST', url: `${url}/${path}`, headers: f.headers, payload: { expectedVersion: 0, config: defaultAssistant() } })).statusCode, 404);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM assistant_configs').get()!.n, 0);
    assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_config_revisions'").get(), undefined);
  } finally { await f.app.close(); }
});

test('移除配置历史的迁移保留当前配置、任务快照和旧任务终态', () => {
  mkdirSync(resolve('data'), { recursive: true }); const root = mkdtempSync(resolve('data/settings-migration-')); const path = join(root, 'db.sqlite');
  try {
    let db = openDatabase(path);
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('u', 'u', 'hash', 'now');
    db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run('c', 'u', '历史', 'now');
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('m', 'c', 'assistant', '原消息', 'now'); db.close();
    const old = new DatabaseSync(path);
    old.exec(`DROP TABLE model_defaults; DROP TABLE model_providers; ALTER TABLE tasks DROP COLUMN model_snapshot; CREATE TABLE model_configs (user_id TEXT PRIMARY KEY REFERENCES users(id), base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL, updated_at TEXT NOT NULL); DROP TABLE assistant_configs;
      CREATE TABLE assistant_config_revisions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,version));
      CREATE TABLE assistant_configs (user_id TEXT PRIMARY KEY REFERENCES users(id), revision_id TEXT NOT NULL REFERENCES assistant_config_revisions(id));
      ALTER TABLE tasks DROP COLUMN assistant_config_snapshot;
      ALTER TABLE tasks ADD COLUMN assistant_config_revision_id TEXT REFERENCES assistant_config_revisions(id);
      DROP TABLE system_log_settings; DROP TABLE system_logs; DELETE FROM schema_migrations WHERE version=14; DROP TABLE schedule_deliveries; ALTER TABLE schedule_occurrences DROP COLUMN delivery_target; ALTER TABLE schedules DROP COLUMN delivery_target; ALTER TABLE channel_accounts DROP COLUMN binding_version; DELETE FROM schema_migrations WHERE version=13; DROP TABLE task_skill_loads; DROP TABLE task_skills; DROP TABLE skills; DROP TRIGGER summary_message_update; DROP TRIGGER summary_message_delete; DROP TABLE conversation_context; DROP INDEX tasks_user_history; ALTER TABLE tasks DROP COLUMN kind; ALTER TABLE tasks DROP COLUMN context_snapshot; DROP TABLE web_settings; ALTER TABLE tasks DROP COLUMN web_snapshot; DROP TABLE schedule_occurrences; DROP TABLE schedules; ALTER TABLE tasks DROP COLUMN tool_policy; DROP TABLE channel_outbox; DROP TABLE channel_inbox; DROP TABLE channel_conversations; DROP TABLE channel_accounts;
      DELETE FROM schema_migrations WHERE version>=5;`);
    for (const version of [0, 1, 2]) old.prepare('INSERT INTO assistant_config_revisions VALUES (?,?,?,?,?)').run(`r${version}`, 'u', version, JSON.stringify({ ...defaultAssistant(), name: `身份${version}` }), 'now');
    old.prepare('INSERT INTO assistant_configs VALUES (?,?)').run('u', 'r2');
    old.prepare('INSERT INTO tasks (id,user_id,conversation_id,status,idempotency_key,input,created_at,assistant_config_revision_id) VALUES (?,?,?,?,?,?,?,?)').run('t', 'u', 'c', 'succeeded', 'key', '原任务', 'now', 'r1');
    old.close();
    db = openDatabase(path);
    assert.equal(getAssistant(db, 'u').config.name, '身份2'); assert.equal(getAssistant(db, 'u').version, 2);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get('t')!;
    assert.equal(task.status, 'succeeded'); assert.equal(JSON.parse(String(task.assistant_config_snapshot)).config.name, '身份1'); assert.ok(!('assistant_config_revision_id' in task));
    assert.equal(db.prepare('SELECT content FROM messages').get()!.content, '原消息');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='assistant_config_revisions'").get(), undefined);
    saveAssistant(db, 'u', { ...defaultAssistant(), name: '最新身份' }, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assistant_configs').get()!.n, 1);
    assert.equal(JSON.parse(String(db.prepare('SELECT assistant_config_snapshot FROM tasks').get()!.assistant_config_snapshot)).config.name, '身份1'); db.close();
    db = openDatabase(path); assert.equal(getAssistant(db, 'u').config.name, '最新身份'); db.close();
  } finally { const child = relative(resolve('data'), root); assert.ok(child && !child.startsWith('..') && !isAbsolute(child)); rmSync(root, { recursive: true }); }
});
