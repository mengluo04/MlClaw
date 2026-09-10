import { formatSystemTime } from '../time.js';
import type { DatabaseSync } from 'node:sqlite';
import { ProviderError, type ModelMessage, type Provider, type ToolCall, type Usage } from '../providers/types.js';
import { ToolError } from '../tools/files.js';
import type { Approvals, ToolRegistry, ToolPolicy } from '../tools/registry.js';
import { assertContextBudget } from './context.js';

export async function runAgent(options: {
  taskId: string; db: DatabaseSync; provider: Provider; messages: ModelMessage[]; registry: ToolRegistry; approvals: Approvals; signal: AbortSignal;
  delta(text: string): void; event(type: string, data: unknown): void; maxRounds?: number; toolPolicy?: ToolPolicy; initialUsage?: Usage;
}) {
  const { taskId, db, provider, messages, registry, approvals, signal, delta, event } = options;
  let totalUsage: Usage | undefined = options.initialUsage ? { ...options.initialUsage } : undefined;
  for (let round = 0; round < (options.maxRounds ?? 8); round++) {
    signal.throwIfAborted();
    assertContextBudget(messages, registry.definitions(options.toolPolicy));
    let calls: ToolCall[] = []; let content = ''; let completed = false;
    for await (const part of provider.stream(messages, registry.definitions(options.toolPolicy), signal)) {
      signal.throwIfAborted();
      if (part.type === 'delta') { content += part.text; delta(part.text); }
      else {
        if (completed) throw new ProviderError('模型重复返回结束事件'); completed = true; calls = part.calls;
        if (part.usage) {
          totalUsage ??= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) totalUsage[key] += part.usage[key];
          db.prepare('UPDATE tasks SET usage=? WHERE id=?').run(JSON.stringify(totalUsage), taskId);
        }
      }
    }
    if (!completed) throw new ProviderError('模型流意外中断');
    if (!calls.length) return;
    if (calls.length > 8) throw new ProviderError('单轮工具调用超过上限');
    messages.push({ role: 'assistant', content, tool_calls: calls });
    for (const call of calls) {
      signal.throwIfAborted();
      let prepared;
      try { prepared = registry.prepare(call, options.toolPolicy); } catch (error) { throw new ProviderError(error instanceof ToolError ? error.message : '工具准备失败'); }
      db.prepare('INSERT INTO tool_calls (id,task_id,name,arguments,status,created_at,arguments_digest,snapshot) VALUES (?,?,?,?,?,?,?,?)').run(prepared.id, taskId, prepared.name, JSON.stringify(prepared.args), prepared.approval ? 'pending' : 'running', formatSystemTime(), prepared.digest, prepared.snapshot);
      let approved = true;
      if (prepared.approval) {
        db.prepare("UPDATE tasks SET status='waiting_approval' WHERE id=?").run(taskId);
        event('tool.pending', { status: 'waiting_approval', toolCallId: prepared.id });
        approved = await approvals.wait(prepared, signal); signal.throwIfAborted();
        db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(taskId);
      }
      let result: string; let status = 'succeeded';
      if (!approved) { result = JSON.stringify({ error: '用户拒绝授权，未执行操作' }); status = 'denied'; }
      else {
        db.prepare("UPDATE tool_calls SET status='running' WHERE id=?").run(prepared.id);
        event('tool.started', { status: 'running', toolCallId: prepared.id });
        try { result = await registry.execute(prepared, AbortSignal.any([signal, AbortSignal.timeout(prepared.name === 'execute_command' ? 30000 : 10000)]), options.toolPolicy); }
        catch (error) { if (registry.executor?.uncertain) throw new ProviderError('命令清理未确认，已停止任务并禁止新任务'); signal.throwIfAborted(); status = 'failed'; result = JSON.stringify({ error: error instanceof ToolError ? error.message : '工具执行失败或超时' }); }
        if (prepared.name === 'execute_command' && JSON.parse(result).status !== 'succeeded') status = 'failed';
      }
      signal.throwIfAborted();
      db.prepare('UPDATE tool_calls SET status=?, result=?, finished_at=? WHERE id=?').run(status, result, formatSystemTime(), prepared.id);
      event('tool.finished', { status: 'running', toolCallId: prepared.id });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  throw new ProviderError('智能体达到最大 8 轮调用上限');
}
