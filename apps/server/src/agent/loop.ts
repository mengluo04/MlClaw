import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ProviderError,
  type ModelMessage,
  type Provider,
  type ToolCall,
} from '../providers/types.js';
import { ToolError } from '../tools/files.js';
import { ToolPermissionError, type ToolRegistry, type ToolPolicy } from '../tools/registry.js';
import { normalizeToolCalls } from '../providers/tool-calls.js';
import { addTaskUsage } from '../tasks/usage.js';
import { streamCheckpoint } from '../providers/stream-checkpoint.js';

/** 持续执行模型及工具循环，直到完成、取消或发生不可恢复错误。 */
export const runAgent = async (options: {
  taskId: string;
  db: DatabaseSync;
  provider: Provider;
  messages: ModelMessage[];
  registry: ToolRegistry;
  signal: AbortSignal;
  delta(text: string): void;
  responseCompleted?(): void;
  event(type: string, data: unknown): void;
  toolPolicy?: ToolPolicy;
}) => {
  /** taskId：当前任务标识；db：当前数据库连接；provider：当前模型或联网服务提供商；messages：当前会话的消息列表；registry：当前任务的工具注册表；signal：当前操作的取消信号；delta：输出增量文本的回调或增量数据；event：当前处理的事件。 */
  const { taskId, db, provider, messages, registry, signal, delta, event } = options;
  const checkpoint = streamCheckpoint();
  while (true) {
    signal.throwIfAborted();
    /** 本轮公开的工具定义同时用于请求和名称匹配。 */
    const definitions = registry.definitions(options.toolPolicy);
    /** 已收集的模型或工具调用。 */
    let calls: ToolCall[] = [];
    /** 当前记录的正文内容。 */
    let content = '';
    /** 已完成的执行结果。 */
    let completed = false;
    for await (/* 逐项处理片段。 */ const part of provider.stream(messages, definitions, signal)) {
      await checkpoint();
      signal.throwIfAborted();
      if (completed) throw new ProviderError('模型在结束事件后继续返回数据');
      if (part.type === 'delta') {
        content += part.text;
        delta(part.text);
      } else {
        completed = true;
        calls = normalizeToolCalls(part.calls, definitions);
        if (part.usage) addTaskUsage(db, taskId, part.usage);
      }
    }
    if (!completed) throw new ProviderError('模型流意外中断');
    options.responseCompleted?.();
    if (!calls.length) return;
    messages.push({ role: 'assistant', content, tool_calls: calls });
    for (/* 逐项处理当前模型工具调用。 */ const call of calls) {
      signal.throwIfAborted();
      /** 完成参数校验与快照固定后的执行数据。 */
      let prepared;
      try {
        prepared = registry.prepare(call, options.toolPolicy);
      } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
        signal.throwIfAborted();
        if (!(error instanceof ToolError)) throw new ProviderError('工具准备失败');
        /** 校验失败仍保存操作记录，并作为工具结果交回模型；不执行该操作。 */
        const id = randomUUID();
        const now = formatSystemTime();
        const result = JSON.stringify({
          status: 'error',
          tool: call.function.name,
          error: error.message,
        });
        /** 非法 JSON 也以有效 JSON 保存，避免任务详情解析失败。 */
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = { invalidArguments: call.function.arguments };
        }
        db.prepare(
          'INSERT INTO tool_calls (id,task_id,name,arguments,status,created_at,result,finished_at,arguments_digest,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          taskId,
          call.function.name,
          JSON.stringify(args),
          'failed',
          now,
          result,
          now,
          '',
          '',
        );
        event('tool.finished', { status: 'running', toolCallId: id });
        if (error instanceof ToolPermissionError) throw new ProviderError(error.message);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        continue;
      }
      db.prepare(
        'INSERT INTO tool_calls (id,task_id,name,arguments,status,created_at,arguments_digest,snapshot) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        prepared.id,
        taskId,
        prepared.name,
        JSON.stringify(prepared.args),
        'running',
        formatSystemTime(),
        prepared.digest,
        prepared.snapshot,
      );
      /** 本次处理结果。 */
      let result: string;
      /** 当前业务状态。 */
      let status = 'succeeded';
      db.prepare("UPDATE tool_calls SET status='running' WHERE id=?").run(prepared.id);
      event('tool.started', { status: 'running', toolCallId: prepared.id });
      try {
        result = await registry.execute(
          prepared,
          AbortSignal.any([
            signal,
            AbortSignal.timeout(
              prepared.name === 'execute_command' ? Number(prepared.args.timeoutMs) + 10000 : 10000,
            ),
          ]),
          options.toolPolicy,
        );
      } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
        if (registry.executor?.uncertain)
          throw new ProviderError('命令清理未确认，已停止任务并禁止新任务');
        signal.throwIfAborted();
        status = 'failed';
        result = JSON.stringify({
          status: 'error',
          tool: prepared.name,
          error: error instanceof ToolError ? error.message : '工具执行失败或超时',
        });
        if (error instanceof ToolPermissionError) {
          db.prepare('UPDATE tool_calls SET status=?, result=?, finished_at=? WHERE id=?').run(
            status,
            result,
            formatSystemTime(),
            prepared.id,
          );
          event('tool.finished', { status: 'running', toolCallId: prepared.id });
          throw new ProviderError(error.message);
        }
      }
      if (prepared.name === 'execute_command' && JSON.parse(result).status !== 'succeeded')
        status = 'failed';
      signal.throwIfAborted();
      db.prepare('UPDATE tool_calls SET status=?, result=?, finished_at=? WHERE id=?').run(
        status,
        result,
        formatSystemTime(),
        prepared.id,
      );
      event('tool.finished', { status: 'running', toolCallId: prepared.id });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
};
