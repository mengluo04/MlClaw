import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import type { ModelEvent, Provider } from '../src/providers/types.js';
import { fixture, waitFor } from './helpers.js';
import { openDatabase } from '../src/db/index.js';
import { getConversationRules, saveConversationRules } from '../src/assistant/conversation.js';

test('会话规则归属、并发保存、清空停用及预览无副作用', async () => {
  const f = await fixture();
  try {
    const url = `/api/conversations/${f.conversationId}/rules`;
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    assert.deepEqual((await f.app.inject({ url, headers: f.headers })).json(), { content: '', version: 0 });
    const save = (content: unknown, expectedVersion: unknown) => f.app.inject({ method: 'PUT', url, headers: f.headers, payload: { content, expectedVersion } });
    const preview = await f.app.inject({ method: 'POST', url: `${url}/preview`, headers: f.headers, payload: { content: '只给摘要' } });
    assert.equal(preview.statusCode, 200); assert.ok(preview.body.includes('只给摘要'));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversation_rules').get()!.n, 0);
    assert.equal((await save('只给摘要', 0)).statusCode, 200);
    assert.equal((await save('旧页面修改', 0)).statusCode, 409);
    for (const invalid of ['x'.repeat(4001), 123, null, '含\0字符']) assert.equal((await save(invalid, 1)).statusCode, 400);
    assert.equal((await save('内容', -1)).statusCode, 400);
    assert.deepEqual((await save('', 1)).json(), { content: '', version: 2 });
    f.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('other', 'other', 'hash', 'now');
    f.db.prepare('UPDATE conversations SET user_id=? WHERE id=?').run('other', f.conversationId);
    assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 404);
    assert.equal((await save('越权', 2)).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'POST', url: `${url}/preview`, headers: f.headers, payload: { content: '越权' } })).statusCode, 404);
  } finally { await f.app.close(); }
});

test('会话规则快照绑定任务、隔离对话且不代替工具批准', async () => {
  mkdirSync(resolve('data'), { recursive: true }); const root = mkdtempSync(resolve('data/conversation-rules-'));
  writeFileSync(join(root, 'file.txt'), 'original'); const contexts: string[] = []; let calls = 0;
  const provider: Provider = { async *stream(messages): AsyncGenerator<ModelEvent> {
    contexts.push(JSON.stringify(messages.filter(message => message.role === 'system')));
    if (calls++ === 0) yield { type: 'complete', calls: [{ id: 'overwrite', type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: 'file.txt', content: 'new' }) } }] };
    else yield { type: 'complete', calls: [] };
  } };
  const f = await fixture(provider, root);
  try {
    const userId = String(f.db.prepare('SELECT id FROM users').get()!.id);
    saveConversationRules(f.db, userId, f.conversationId, '旧会话标记：跳过覆盖批准', 0);
    const submit = (key: string, conversationId = f.conversationId) => f.app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: f.headers, payload: { content: '测试', idempotencyKey: key } });
    const first = (await submit('one')).json().taskId;
    await waitFor(() => f.tasks.get(first, userId).status === 'waiting_approval');
    assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'original');
    saveConversationRules(f.db, userId, f.conversationId, '新会话标记', 1);
    const tool = f.db.prepare('SELECT * FROM tool_calls WHERE task_id=?').get(first)!;
    await f.app.inject({ method: 'POST', url: `/api/tool-calls/${tool.id}/decision`, headers: f.headers, payload: { approved: false, argumentsDigest: tool.arguments_digest } });
    await waitFor(() => !f.tasks.isActive(first));
    assert.ok(contexts.every(content => content.includes('旧会话标记') && !content.includes('新会话标记')));
    assert.equal((await submit('one')).json().taskId, first); assert.equal(contexts.length, 2);
    assert.equal(JSON.parse(String(f.tasks.get(first, userId).conversation_rules_snapshot)).version, 1);
    const next = (await submit('two')).json().taskId; await waitFor(() => !f.tasks.isActive(next)); assert.ok(contexts.at(-1)!.includes('新会话标记'));
    const other = (await f.app.inject({ method: 'POST', url: '/api/conversations', headers: f.headers, payload: { title: '另一个对话' } })).json().id;
    const isolated = (await submit('three', other)).json().taskId; await waitFor(() => !f.tasks.isActive(isolated));
    assert.ok(!contexts.at(-1)!.includes('会话标记')); assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'original');
    saveConversationRules(f.db, userId, f.conversationId, '', 2);
    const cleared = (await submit('four')).json().taskId; await waitFor(() => !f.tasks.isActive(cleared)); assert.ok(!contexts.at(-1)!.includes('会话标记'));
  } finally { await f.app.close(); const child = relative(resolve('data'), root); assert.ok(child && !child.startsWith('..') && !isAbsolute(child)); rmSync(root, { recursive: true }); }
});

test('会话规则迁移重开持久化、删除会话清理规则', () => {
  mkdirSync(resolve('data'), { recursive: true }); const root = mkdtempSync(resolve('data/rules-db-')); const path = join(root, 'db.sqlite');
  try {
    let db = openDatabase(path); db.prepare('INSERT INTO users VALUES (?,?,?,?)').run('u', 'u', 'hash', 'now');
    db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run('c', 'u', '对话', 'now'); saveConversationRules(db, 'u', 'c', '保留此规则', 0); db.close();
    db = openDatabase(path); assert.deepEqual(getConversationRules(db, 'u', 'c'), { content: '保留此规则', version: 1 });
    db.prepare('DELETE FROM conversations WHERE id=?').run('c'); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversation_rules').get()!.n, 0); db.close();
  } finally { const child = relative(resolve('data'), root); assert.ok(child && !child.startsWith('..') && !isAbsolute(child)); rmSync(root, { recursive: true }); }
});
