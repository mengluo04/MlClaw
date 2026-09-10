import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import type { AssistantSettings, Task } from '@mlclaw/shared';
import { createApp } from '../apps/server/src/app.js';

// 显式运行才会调用真实模型并产生费用；凭据只留在进程和内存数据库。
const custom = Boolean(process.env.MLCLAW_TEST_API_KEY || process.env.MLCLAW_TEST_BASE_URL || process.env.MLCLAW_TEST_MODEL);
if (custom && !(process.env.MLCLAW_TEST_API_KEY && process.env.MLCLAW_TEST_BASE_URL && process.env.MLCLAW_TEST_MODEL)) throw new Error('自定义验收服务必须同时配置 MLCLAW_TEST_API_KEY、MLCLAW_TEST_BASE_URL 和 MLCLAW_TEST_MODEL，不能沿用其他服务密钥');
const apiKey = custom ? process.env.MLCLAW_TEST_API_KEY : process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('真实模型验证需要 MLCLAW_TEST_API_KEY 或 DEEPSEEK_API_KEY');
const baseUrl = custom ? process.env.MLCLAW_TEST_BASE_URL! : 'https://api.deepseek.com';
const model = custom ? process.env.MLCLAW_TEST_MODEL! : 'deepseek-v4-flash';
mkdirSync(resolve('data'), { recursive: true });
const root = mkdtempSync(resolve('data/real-model-'));
const origin = 'http://127.0.0.1:5173';
const password = randomBytes(24).toString('hex');
const { app } = await createApp({ host: '127.0.0.1', port: 3000, databasePath: ':memory:', origin, secureCookie: false, adminUsername: 'verify', adminPassword: password, sessionSeconds: 3600, workspacePath: root });
const checks: string[] = [];
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  let cookie = '';
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${base}/api${path}`, { method, headers: { origin, cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    if (path === '/auth/login') cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (!response.ok) { await response.body?.cancel(); throw new Error(`验证接口失败：${path} HTTP ${response.status}`); }
    return await response.json() as T;
  }
  await api('/auth/login', 'POST', { username: 'verify', password });
  const provider = await api<{ id: string }>('/settings/providers', 'POST', { name: '真实验证', baseUrl, models: [model], apiKey });
  await api('/settings/model-default', 'PUT', { providerId: provider.id, model });
  const safe = await api<{ providers: { hasApiKey: boolean; apiKey?: string }[] }>('/settings/models'); assert.equal(safe.providers[0]!.hasApiKey, true); assert.equal(safe.providers[0]!.apiKey, undefined);
  await api(`/settings/providers/${provider.id}/test`, 'POST', { model }); checks.push('真实模型连接与配置脱敏'); console.log('通过：真实模型连接');
  const conversation = await api<{ id: string }>('/conversations', 'POST', { title: '真实模型验收' });
  async function send(content: string, decision?: { approved: boolean; content: string }) {
    const payload = { content, idempotencyKey: randomUUID() };
    const { taskId } = await api<{ taskId: string }>(`/conversations/${conversation.id}/messages`, 'POST', payload);
    let task: Task; const deadline = Date.now() + 125000;
    const decided = new Set<string>();
    while (true) {
      task = await api<Task>(`/tasks/${taskId}`);
      for (const tool of task.tools ?? []) if (tool.status === 'pending' && !decided.has(tool.id)) {
        const args: unknown = JSON.parse(tool.arguments);
        assert.ok(decision, '模型意外请求授权');
        assert.equal(tool.name, 'write_text'); assert.deepEqual(args, { path: 'verified.txt', content: decision.content });
        await api(`/tool-calls/${tool.id}/decision`, 'POST', { approved: decision.approved, argumentsDigest: tool.arguments_digest }); decided.add(tool.id);
      }
      if (!['queued', 'running', 'waiting_approval'].includes(task.status)) break;
      if (Date.now() > deadline) { await api(`/tasks/${taskId}/cancel`, 'POST'); throw new Error('真实模型任务验收超时'); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(task.status, 'succeeded', task.error ?? '模型任务未成功');
    assert.deepEqual(JSON.parse(task.model_snapshot!), { providerId: provider.id, providerName: '真实验证', model });
    const duplicate = await api<{ taskId: string }>(`/conversations/${conversation.id}/messages`, 'POST', payload); assert.equal(duplicate.taskId, taskId);
    const events = await fetch(`${base}/api/tasks/${taskId}/events`, { headers: { cookie }, signal: AbortSignal.timeout(10000) });
    const text = await events.text(); assert.ok(text.includes('task.finished')); assert.ok(!text.includes(apiKey!));
    const reply = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as { type: string; data: { text?: string } }).filter(event => event.type === 'message.delta').map(event => event.data.text ?? '').join('');
    return { task, events: text, reply };
  }
  const assistant = await api<AssistantSettings>('/settings/assistant');
  const identity = `小洛${randomBytes(3).toString('hex')}`;
  const userName = `测试用户${randomBytes(3).toString('hex')}`;
  await api('/settings/assistant', 'PUT', { expectedVersion: assistant.version, config: { ...assistant.config, name: identity, userName, personality: '回答简洁，使用中文。', rules: [{ id: 'identity-format', enabled: true, content: '当用户询问身份与称呼时，只用一句话说明你的名字和用户称呼，不调用工具。' }], onboardingCompleted: true } });
  const identityResult = await send('请介绍你的身份，并说明应该如何称呼我。');
  assert.ok(identityResult.reply.includes(identity), `回复未包含配置的助手名称：${identityResult.reply.replaceAll(apiKey!, '[密钥已隐藏]')}`); assert.ok(identityResult.reply.includes(userName)); assert.ok(identityResult.reply.length < 200); assert.equal(identityResult.task.tools?.length, 0);
  checks.push('真实模型助手身份、用户称呼与简洁中文表达'); console.log('通过：真实模型助手身份与表达');
  const marker = `MLCLAW-${randomBytes(4).toString('hex')}`;
  await send(`请记住本次对话的测试代号 ${marker}，只回复“已记住”，不要调用工具。`);
  const recall = await send('上一条消息的测试代号是什么？只回复代号，不要调用工具。'); assert.ok(recall.reply.includes(marker));
  assert.ok(recall.task.usage); assert.ok(JSON.parse(recall.task.usage).total_tokens > 0); checks.push('真实模型多轮上下文、流式事件与上报用量'); console.log('通过：真实模型多轮对话、SSE 与用量');
  const created = await send(`请调用 write_text 创建 verified.txt，内容精确为 ${marker}（无换行），然后调用 read_text 读取该文件，最后简短报告读取结果。只操作这个文件。`);
  assert.equal(readFileSync(join(root, 'verified.txt'), 'utf8'), marker);
  assert.ok(created.task.tools?.some(tool => tool.name === 'write_text' && tool.status === 'succeeded'));
  assert.ok(created.task.tools?.some(tool => tool.name === 'read_text' && tool.status === 'succeeded'));
  checks.push('真实模型自主创建并读取文件'); console.log('通过：真实模型文件工具循环');
  const denied = await send('请调用 write_text 将 verified.txt 精确覆盖为 DENIED（无换行）。如果用户拒绝授权，就结束任务，不要换方法或重试。', { approved: false, content: 'DENIED' });
  assert.equal(readFileSync(join(root, 'verified.txt'), 'utf8'), marker); assert.ok(denied.task.tools?.some(tool => tool.status === 'denied'));
  const approved = await send('请调用 write_text 将 verified.txt 精确覆盖为 APPROVED（无换行），然后读取验证。', { approved: true, content: 'APPROVED' });
  assert.equal(readFileSync(join(root, 'verified.txt'), 'utf8'), 'APPROVED'); assert.ok(approved.task.tools?.some(tool => tool.name === 'write_text' && tool.status === 'succeeded'));
  checks.push('真实工具调用拒绝/批准与实际文件效果'); console.log('通过：真实模型覆盖拒绝和批准');
  writeFileSync(resolve('data/real-model-result.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), model, providerOrigin: new URL(baseUrl).origin, checks }, null, 2));
  console.log('真实模型验收通过；脱敏结果保存在 data/real-model-result.json');
} finally {
  await app.close();
  const path = relative(resolve('data'), root); assert.ok(path && !path.startsWith('..') && !isAbsolute(path)); rmSync(root, { recursive: true });
}
