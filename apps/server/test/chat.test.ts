import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CompatibleProvider, parseSse } from '../src/providers/compatible.js';
import type { Provider, ModelMessage, ModelEvent } from '../src/providers/types.js';
import { fixture, waitFor } from './helpers.js';
import { renderMarkdown } from '../../web/src/markdown.js';

test('SSE 逐字节 UTF-8、CRLF 和多行解析，拒绝超大事件与截断', async () => {
  const bytes = new TextEncoder().encode(': comment\r\ndata: 中文\r\ndata: 第二行\r\n\r\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  assert.deepEqual(await Array.fromAsync(parseSse(stream)), ['中文\n第二行', '[DONE]']);
  for (const text of ['data: missing-end', 'data: ' + 'x'.repeat(131073) + '\n\n']) {
    const body = new Response(text).body!; await assert.rejects(Array.fromAsync(parseSse(body)));
  }
});

test('兼容 Provider 覆盖流文本、工具片段、用量、错误和取消', async () => {
  let mode = 'ok';
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk; }
    if (mode === '401' || mode === '429') { response.writeHead(Number(mode)); response.end('secret-upstream-error'); return; }
    if (mode === 'wait') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    event({ content: '你好' });
    if (mode === 'broken') { response.end(); return; }
    if (mode === 'tools') {
      event({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_text', arguments: '{"path":' } }] });
      event({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] });
    }
    event({}, mode === 'tools' ? 'tool_calls' : 'stop');
    response.write('data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const config = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'secret', model: 'test' };
  const provider = new CompatibleProvider(config, 1000);
  try {
    const run = () => Array.fromAsync(provider.stream([{ role: 'user', content: '你好' }], [], new AbortController().signal));
    const result = await run(); assert.equal(result[0]!.type, 'delta'); assert.deepEqual(result[1], { type: 'complete', calls: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
    mode = 'tools'; const tools = await run(); assert.deepEqual(tools[1], { type: 'complete', calls: [{ id: 'call-1', type: 'function', function: { name: 'read_text', arguments: '{"path":"a.txt"}' } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
    for (const errorMode of ['401', '429', 'broken']) { mode = errorMode; await assert.rejects(run(), error => error instanceof Error && !error.message.includes('secret')); }
    mode = 'wait'; await assert.rejects(Array.fromAsync(new CompatibleProvider(config, 40).stream([], [], new AbortController().signal)), /超时/);
    const controller = new AbortController(); setTimeout(() => controller.abort(new Error('用户停止')), 30);
    await assert.rejects(Array.fromAsync(provider.stream([], [], controller.signal)), /用户停止/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('对话任务幂等、消息持久化、上下文与 SSE 补发', async () => {
  let calls = 0; const contexts: ModelMessage[][] = [];
  const provider: Provider = { async *stream(messages) { calls++; contexts.push(messages); yield { type: 'delta', text: '模拟回复' }; yield { type: 'complete', calls: [] }; } };
  const f = await fixture(provider);
  try {
    const url = `/api/conversations/${f.conversationId}/messages`;
    const submit = (key: string, content = '你好') => f.app.inject({ method: 'POST', url, headers: f.headers, payload: { content, idempotencyKey: key } });
    const first = await submit('key1'); assert.equal(first.statusCode, 202); const id = first.json().taskId;
    await waitFor(() => !f.tasks.isActive(id));
    assert.equal((await submit('key1')).json().taskId, id); assert.equal(calls, 1);
    assert.equal((await submit('key1', 'different')).statusCode, 409);
    const second = await submit('key2', '继续'); await waitFor(() => !f.tasks.isActive(second.json().taskId));
    assert.deepEqual(contexts[1]!.filter(item => item.role !== 'system').map(item => item.content), ['你好', '模拟回复', '继续']);
    const messages = (await f.app.inject({ url, headers: f.headers })).json(); assert.equal(messages.messages.length, 4);
    assert.equal((await f.app.inject({ url: `/api/tasks/${id}`, headers: f.headers })).json().status, 'succeeded');
    const events = await f.app.inject({ url: `/api/tasks/${id}/events`, headers: f.headers });
    const frames = events.body.split('\n\n').filter(Boolean); assert.ok(frames.length >= 4);
    const replay = await f.app.inject({ url: `/api/tasks/${id}/events`, headers: { ...f.headers, 'last-event-id': '2' } }); assert.ok(!replay.body.includes('id: 1\n')); assert.ok(replay.body.includes('message.delta'));
    assert.equal((await f.app.inject({ url: `/api/tasks/${id}/events?after=-1`, headers: f.headers })).statusCode, 400);
    const otherId = 'other-user'; f.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(otherId, 'other', 'hash', 'now');
    f.db.prepare('UPDATE conversations SET user_id=? WHERE id=?').run(otherId, f.conversationId);
    assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 404);
    f.db.prepare('UPDATE tasks SET user_id=? WHERE id=?').run(otherId, id);
    assert.equal((await f.app.inject({ url: `/api/tasks/${id}/events`, headers: f.headers })).statusCode, 404);
  } finally { await f.app.close(); }
});

test('取消后不写入迟到的增量、拒绝并发任务、失败不自动重试', async () => {
  let resolveLate: (() => void) | undefined;
  const provider: Provider = { async *stream(): AsyncGenerator<ModelEvent> { yield { type: 'delta', text: '前半段' }; await new Promise<void>(resolve => { resolveLate = resolve; }); yield { type: 'delta', text: '不应保存' }; yield { type: 'complete', calls: [] }; } };
  const f = await fixture(provider);
  try {
    const submit = (key: string) => f.app.inject({ method: 'POST', url: `/api/conversations/${f.conversationId}/messages`, headers: f.headers, payload: { content: '测试', idempotencyKey: key } });
    const id = (await submit('one')).json().taskId;
    await waitFor(() => !!resolveLate);
    assert.equal((await submit('two')).statusCode, 409);
    await f.app.inject({ method: 'POST', url: `/api/tasks/${id}/cancel`, headers: f.headers }); resolveLate!();
    await new Promise(resolve => setTimeout(resolve, 20));
    const task = (await f.app.inject({ url: `/api/tasks/${id}`, headers: f.headers })).json(); assert.equal(task.status, 'cancelled');
    const rows = f.db.prepare('SELECT content FROM messages').all(); assert.ok(!JSON.stringify(rows).includes('不应保存'));
  } finally { resolveLate?.(); await f.app.close(); }
});

test('Markdown 禁止脚本、事件属性、危险链接和远程图片', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[x](javascript:alert(1))\n![x](https://evil.example/pixel)\n```html\n<script>test</script>\n```');
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('href="javascript:')); assert.ok(html.includes('<pre><code'));
});
