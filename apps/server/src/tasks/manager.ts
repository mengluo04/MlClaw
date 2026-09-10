import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/index.js';
import { CompatibleProvider } from '../providers/compatible.js';
import { ProviderError, type Provider, type Usage } from '../providers/types.js';
import { getModelConfig } from '../models/store.js';
import { ToolRegistry, Approvals, type ToolPolicy } from '../tools/registry.js';
import { runAgent } from '../agent/loop.js';
import { resolve } from 'node:path';
import type { ExecutorClient } from '../tools/executor.js';
import { memoryContext } from '../memory/index.js';
import { getAssistant } from '../assistant/store.js';
import { parseAssistant } from '../assistant/config.js';
import { buildContext } from '../agent/context.js';
import { getConversationRules } from '../assistant/conversation.js';
import { WebService, type WebSession } from '../web/service.js';
import { publicWebConfig } from '../web/store.js';
import type { Skill } from '@mlclaw/shared';
import { listSkills } from '../skills/store.js';
import { SkillSession } from '../skills/session.js';
import { RetrievalSession } from '../retrieval/search.js';
import { generateSummary, getConversationContext, historyWindow, summaryTarget } from '../agent/summary.js';
import type { SystemLogService } from '../system-logs/service.js';

export const activeStates = ['queued', 'running', 'waiting_approval'];
export class TaskError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }
export class TaskManager {
  private running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  readonly registry: ToolRegistry;
  readonly approvals: Approvals;
  constructor(public db: DatabaseSync, private providerFactory?: (userId: string) => Provider, workspacePath = resolve('workspace'), executor?: ExecutorClient, readonly web = new WebService(db), private logs?: SystemLogService) {
    this.registry = new ToolRegistry(workspacePath, executor); this.approvals = new Approvals(db);
    transaction(db, () => {
      for (const task of db.prepare("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_approval')").all()) {
        this.finish(String(task.id), 'interrupted', '服务重启，任务已中断；需要手动重试');
      }
    });
  }
  registryFor(userId: string, policy: ToolPolicy = 'full', conversationId?: string) {
    return new ToolRegistry(this.registry.workspace.root, this.registry.executor, this.web.session(userId, policy), new RetrievalSession(this.db, userId, conversationId), new SkillSession(this.db, userId, listSkills(this.db, userId).filter(item => item.enabled)));
  }
  event(taskId: string, type: string, data: unknown) {
    this.db.prepare('INSERT INTO task_events SELECT ?, COALESCE(MAX(seq), 0)+1, ?, ?, ? FROM task_events WHERE task_id=?').run(taskId, type, JSON.stringify(data), formatSystemTime(), taskId);
  }
  get(taskId: string, userId: string) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, userId);
    if (!row) throw new TaskError('任务不存在', 404); return row;
  }
  isActive(taskId: string) { const row = this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId); return !!row && activeStates.includes(String(row.status)); }
  isBusy() { return this.running.size > 0 || !!this.db.prepare("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_approval')").get(); }
  assertWorkspaceIdle() {
    if (this.registry.executor?.uncertain) throw new TaskError('命令清理状态不确定，请检查执行服务后重启', 503);
    if (this.running.size || this.db.prepare("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_approval')").get()) throw new TaskError('任务运行或清理期间不能上传文件', 409);
  }
  finish(taskId: string, status: string, error?: string) {
    if (!this.isActive(taskId)) return;
    this.db.prepare('UPDATE tasks SET status=?, error=?, finished_at=? WHERE id=?').run(status, error ?? null, formatSystemTime(), taskId);
    this.db.prepare("UPDATE tool_calls SET status='interrupted', finished_at=? WHERE task_id=? AND status IN ('pending','running')").run(formatSystemTime(), taskId);
    this.event(taskId, status === 'succeeded' ? 'task.finished' : status === 'cancelled' ? 'task.cancelled' : 'task.failed', { status, ...(error ? { message: error } : {}) });
    this.db.prepare("UPDATE schedule_occurrences SET status=?,reason=?,finished_at=? WHERE task_id=? AND status='running'").run(status, error ?? null, formatSystemTime(), taskId);
    const task = this.db.prepare('SELECT user_id,kind FROM tasks WHERE id=?').get(taskId);
    if (task && ['failed', 'cancelled', 'interrupted'].includes(status)) this.logs?.record(String(task.user_id), {
      level: status === 'failed' ? 'error' : 'warning', source: 'task', event: `task.${status}`,
      message: status === 'failed' ? '后台任务执行失败' : status === 'cancelled' ? '后台任务已取消' : '后台任务因服务状态变化而中断',
      entity: { type: 'task', id: taskId }, metadata: { kind: String(task.kind), status, reason: error?.slice(0, 200) ?? null },
    });
    if (task) for (const call of this.db.prepare("SELECT id,name,status FROM tool_calls WHERE task_id=? AND name IN ('write_text','execute_command')").all(taskId)) {
      const succeeded = call.status === 'succeeded'; const denied = call.status === 'denied';
      this.logs?.record(String(task.user_id), {
        level: succeeded ? 'info' : denied ? 'warning' : 'error', source: call.name === 'execute_command' ? 'executor' : 'storage',
        event: call.name === 'execute_command' ? `executor.command_${String(call.status)}` : `storage.write_${String(call.status)}`,
        message: `${call.name === 'execute_command' ? '隔离命令执行' : '文件写入'}${succeeded ? '成功' : denied ? '被拒绝' : '失败'}`,
        entity: { type: 'tool', id: String(call.id) }, metadata: { toolName: String(call.name), status: String(call.status) },
      });
    }
  }
  create(userId: string, conversationId: string, input: string, key: string) {
    const prepared = transaction(this.db, () => this.prepare(userId, conversationId, input, key));
    prepared.start();
    return prepared.taskId;
  }
  createSummary(userId: string, conversationId: string, key: string, expectedVersion: number) {
    const prepared = transaction(this.db, () => this.prepare(userId, conversationId, '生成会话摘要', key, 'readonly', 'summary', expectedVersion));
    prepared.start(); return prepared.taskId;
  }
  // 调用方必须在事务内准备并关联业务记录，事务提交后才能调用 start。
  prepare(userId: string, conversationId: string, input: string, key: string, policy: ToolPolicy = 'full', kind: 'chat' | 'summary' = 'chat', expectedVersion?: number) {
    if (!this.db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId)) throw new TaskError('会话不存在', 404);
    const previous = this.db.prepare('SELECT id, input, conversation_id, tool_policy,kind,context_snapshot FROM tasks WHERE user_id=? AND idempotency_key=?').get(userId, key);
    if (previous) {
      if (previous.input !== input || previous.conversation_id !== conversationId || previous.tool_policy !== policy || previous.kind !== kind || kind === 'summary' && JSON.parse(String(previous.context_snapshot)).version !== expectedVersion) throw new TaskError('幂等键已绑定其他请求', 409);
      return { taskId: String(previous.id), start() {} };
    }
    const model = getModelConfig(this.db, userId);
    if (!this.providerFactory && !model) throw new TaskError('请先配置提供商并指定全局默认模型');
    if (this.registry.executor?.uncertain) throw new TaskError('命令清理状态不确定，请检查执行服务后重启', 503);
    if (this.isBusy()) throw new TaskError('上一任务仍在运行或清理，请稍后重试', 409);
    const context = getConversationContext(this.db, userId, conversationId);
    if (kind === 'summary' && expectedVersion !== context.version) throw new TaskError('会话摘要设置已被其他操作更新，请刷新后重试', 409);
    if (kind === 'summary' && !context.remainingMessages) throw new TaskError('没有需要生成摘要的新消息');
    const taskId = randomUUID(); const now = formatSystemTime();
    const assistant = getAssistant(this.db, userId);
    const conversationRules = getConversationRules(this.db, userId, conversationId);
    const web = this.web.session(userId, policy);
    this.db.prepare('INSERT INTO tasks (id,user_id,conversation_id,status,idempotency_key,input,created_at,assistant_config_snapshot,conversation_rules_snapshot,model_snapshot,tool_policy) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(taskId, userId, conversationId, 'queued', key, input, now, JSON.stringify(assistant), JSON.stringify(conversationRules), model ? JSON.stringify({ providerId: model.providerId, providerName: model.providerName, model: model.model }) : null, policy);
    this.db.prepare('UPDATE tasks SET kind=?,context_snapshot=? WHERE id=?').run(kind, JSON.stringify({ version: context.version, autoSummary: context.autoSummary, throughMessageId: context.valid ? context.throughMessageId : null }), taskId);
    if (kind === 'chat') this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(randomUUID(), conversationId, 'user', input, now);
    this.db.prepare('UPDATE tasks SET web_snapshot=? WHERE id=?').run(JSON.stringify(publicWebConfig(web.config)), taskId);
    this.db.prepare('INSERT INTO task_skills VALUES (?,?)').run(taskId, JSON.stringify(kind === 'summary' ? [] : listSkills(this.db, userId).filter(item => item.enabled)));
    this.event(taskId, 'task.queued', { status: 'queued' });
    return { taskId, start: () => {
      if (this.running.has(taskId) || this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)?.status !== 'queued') return;
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.run(taskId, userId, conversationId, controller.signal, model, web)).finally(() => this.running.delete(taskId));
      this.running.set(taskId, { controller, promise });
    } };
  }
  private async run(taskId: string, userId: string, conversationId: string, cancelSignal: AbortSignal, model: ReturnType<typeof getModelConfig>, web: WebSession) {
    const signal = AbortSignal.any([cancelSignal, AbortSignal.timeout(120000)]);
    let text = ''; const messageId = randomUUID();
    try {
      signal.throwIfAborted(); if (!this.isActive(taskId)) return;
      this.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(taskId);
      this.event(taskId, 'task.started', { status: 'running' });
      const provider = this.providerFactory?.(userId) ?? new CompatibleProvider(model!);
      const task = this.get(taskId, userId);
      const toolPolicy: ToolPolicy = task.tool_policy === 'readonly' ? 'readonly' : 'full';
      const skillSnapshot: Skill[] = JSON.parse(String(this.db.prepare('SELECT snapshot FROM task_skills WHERE task_id=?').get(taskId)?.snapshot ?? '[]'));
      const skills = new SkillSession(this.db, userId, skillSnapshot, taskId, (type,data) => { signal.throwIfAborted(); this.event(taskId,type,data); });
      const registry = new ToolRegistry(this.registry.workspace.root, this.registry.executor, web, new RetrievalSession(this.db, userId, conversationId), skills);
      let context = getConversationContext(this.db, userId, conversationId);
      const contextSnapshot: { version: number; autoSummary: boolean } = JSON.parse(String(task.context_snapshot));
      let summaryUsage: Usage | undefined;
      const summarize = async (manual: boolean) => {
        context = await generateSummary({ db: this.db, userId, conversationId, state: context, target: summaryTarget(this.db, conversationId, context, manual),
          provider, model: model ? `${model.providerName} / ${model.model}` : null, signal,
          event: (type, data) => { signal.throwIfAborted(); this.event(taskId, type, data); },
          usage: value => {
            summaryUsage ??= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
            for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) summaryUsage[key] += value[key];
            this.db.prepare('UPDATE tasks SET usage=? WHERE id=?').run(JSON.stringify(summaryUsage), taskId);
          },
        });
      };
      if (task.kind === 'summary') {
        if (context.version !== contextSnapshot.version) throw new ProviderError('摘要设置已经改变，请重新生成');
        await summarize(true); this.finish(taskId, 'succeeded'); return;
      }
      const assistant: { config: unknown } = JSON.parse(String(task.assistant_config_snapshot));
      const config = parseAssistant(assistant.config);
      const conversationRules: { content: string } = JSON.parse(String(task.conversation_rules_snapshot));
      const build = () => buildContext({ config, tools: registry.definitions(toolPolicy), memory: memoryContext(this.db, userId, String(task.input)),
        skills: skills.catalog(), history: historyWindow(this.db, conversationId, context).messages.slice(-40), summary: context.valid ? context.summary : undefined,
        now: String(task.created_at), conversationRules: conversationRules.content });
      let built = build();
      if (contextSnapshot.autoSummary && context.autoSummary && (historyWindow(this.db, conversationId, context).needsSummary || built.preview.budget.omittedMessages > 0)) {
        await summarize(false); built = build();
        if (historyWindow(this.db, conversationId, context).needsSummary || built.preview.budget.omittedMessages > 0) throw new ProviderError('已分批保存摘要，仍有较多历史未覆盖；请在会话摘要中继续生成后重试');
      }
      const omitted = Math.max(0, context.remainingMessages - (built.messages.length - built.preview.sections.length));
      if (omitted) this.event(taskId, 'context.omitted', { message: `${omitted} 条较早消息未进入本次上下文，可生成会话摘要后继续` });
      await runAgent({ taskId, db: this.db, provider, messages: built.messages, registry, approvals: this.approvals, signal, toolPolicy, initialUsage: summaryUsage,
        event: (type, data) => { signal.throwIfAborted(); this.event(taskId, type, data); },
        delta: chunk => {
          signal.throwIfAborted();
          text += chunk; if (text.length > 32768) throw new ProviderError('模型输出超过上限');
          this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content').run(messageId, conversationId, 'assistant', text, formatSystemTime());
          this.event(taskId, 'message.delta', { messageId, text: chunk });
        },
      });
      this.finish(taskId, 'succeeded');
    } catch (error) {
      this.finish(taskId, cancelSignal.aborted ? 'cancelled' : 'failed', cancelSignal.aborted ? '用户取消任务' : signal.aborted ? '任务达到总时限' : error instanceof ProviderError ? error.message : '任务执行失败');
    }
  }
  cancel(taskId: string, userId: string) {
    this.get(taskId, userId);
    this.finish(taskId, 'cancelled', '用户取消任务'); this.running.get(taskId)?.controller.abort();
  }
  async close() {
    for (const [id, run] of this.running) { this.finish(id, 'interrupted', '服务关闭，任务已中断'); run.controller.abort(); }
    await Promise.all([...this.running.values()].map(run => run.promise));
  }
}
