import { formatSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/index.js';
import { CompatibleProvider } from '../providers/compatible.js';
import { ProviderError, type Provider, type ModelMessage } from '../providers/types.js';
import { recoveringProvider } from '../providers/recovering.js';
import { recoverContext, SUMMARY_PREFIX } from '../agent/compaction.js';
import { addTaskUsage } from './usage.js';
import type { DefaultModel } from '@mlclaw/shared';
import { getModelConfig } from '../models/store.js';
import { ToolRegistry, type ToolPolicy } from '../tools/registry.js';
import { runAgent } from '../agent/loop.js';
import { resolve } from 'node:path';
import type { ScriptExecutor } from '../tools/script-executor.js';
import { memoryContext } from '../memory/index.js';
import { getAssistant, saveAssistant } from '../assistant/store.js';
import { parseAssistant } from '../assistant/config.js';
import { buildContext } from '../agent/context.js';
import { getConversationRules } from '../assistant/conversation.js';
import { WebService, type WebSession } from '../web/service.js';
import { publicWebConfig } from '../web/store.js';
import type { Skill } from '@mlclaw/shared';
import { SkillStore } from '../skills/store.js';
import { SkillSession } from '../skills/session.js';
import { RetrievalSession } from '../retrieval/search.js';
import {
  generateSummary,
  getConversationContext,
  historyWindow,
  summaryTarget,
} from '../agent/summary.js';
import type { SystemLogService } from '../system-logs/service.js';
import { TaskOutput } from './output.js';
import type { TaskEvent } from '@mlclaw/shared';

/** 需要视为活动任务的状态集合。 */
export const activeStates = ['queued', 'running', 'waiting_approval'];
export class TaskError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export class TaskManager {
  /** 应用初始化后接入共享业务工具，预览和实际聊天使用同一注册入口。 */
  registerApplicationTools?: (registry: ToolRegistry, userId: string) => void;
  /** 外部操作进行中标记，用于禁用重复提交。 */
  externalBusy: () => boolean = () => false;
  /** 按标识保存的running映射。 */
  private running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  /** 当前任务的工具注册表。 */
  readonly registry: ToolRegistry;
  /** 技能包直接来自授权工作区的 skills 目录。 */
  readonly skills: SkillStore;
  readonly output: TaskOutput;
  constructor(
    public db: DatabaseSync,
    private providerFactory?: (userId: string) => Provider,
    workspacePath = resolve('workspace'),
    executor?: ScriptExecutor,
    readonly web = new WebService(db),
    private logs?: SystemLogService,
  ) {
    this.output = new TaskOutput(db);
    this.registry = new ToolRegistry(workspacePath, executor);
    this.skills = new SkillStore(this.registry.workspace);
    transaction(db, () => {
      for (/* 逐项处理当前任务记录。 */ const task of db
        .prepare("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_approval')")
        .all()) {
        this.finish(String(task.id), 'interrupted', '服务重启，任务已中断；需要手动重试');
      }
    });
  }
  /** 创建符合当前用户权限的工具注册表。 */
  registryFor(userId: string, policy: ToolPolicy = 'full', conversationId?: string) {
    const registry = new ToolRegistry(
      this.registry.workspace.root,
      this.registry.executor,
      this.web.session(userId, policy),
      new RetrievalSession(this.db, userId, conversationId),
      new SkillSession(
        this.db,
        this.skills,
        this.skills.scan().skills.filter((item) => item.enabled),
      ),
    );
    this.registerApplicationTools?.(registry, userId);
    return registry;
  }
  /** 构造或记录统一事件数据。 */
  event(taskId: string, type: string, data: unknown) {
    this.output.record(taskId, type, data as TaskEvent['data']);
  }
  /** 读取指定记录。 */
  get(taskId: string, userId: string) {
    /** tasks 表的查询记录。 */
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, userId);
    if (!row) throw new TaskError('任务不存在', 404);
    return row;
  }
  /** 判断当前记录是否处于活动状态。 */
  isActive(taskId: string) {
    /** tasks 表的查询记录。 */
    const row = this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId);
    return !!row && activeStates.includes(String(row.status));
  }
  /** 判断执行器是否正在处理任务。 */
  isBusy() {
    return (
      this.externalBusy() ||
      this.running.size > 0 ||
      !!this.db
        .prepare("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_approval')")
        .get()
    );
  }
  /** 阻止任务执行期间的冲突工作区操作。 */
  assertWorkspaceIdle() {
    if (this.externalBusy()) throw new TaskError('定时命令运行或清理期间不能操作工作目录', 409);
    if (this.registry.executor?.uncertain)
      throw new TaskError('命令清理状态不确定，请检查脚本运行环境后重启', 503);
    if (
      this.running.size ||
      this.db
        .prepare("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_approval')")
        .get()
    )
      throw new TaskError('任务运行或清理期间不能修改工作区', 409);
  }
  /** 完成当前处理并释放等待方。 */
  finish(taskId: string, status: string, error?: string) {
    if (!this.isActive(taskId)) return;
    try {
      this.output.flush(taskId);
    } catch {
      status = 'failed';
      error = '保存消息失败，未保存的输出可能丢失';
    }
    this.db
      .prepare('UPDATE tasks SET status=?, error=?, finished_at=? WHERE id=?')
      .run(status, error ?? null, formatSystemTime(), taskId);
    this.db
      .prepare(
        "UPDATE tool_calls SET status='interrupted', finished_at=? WHERE task_id=? AND status IN ('pending','running')",
      )
      .run(formatSystemTime(), taskId);
    this.event(
      taskId,
      status === 'succeeded'
        ? 'task.finished'
        : status === 'cancelled'
          ? 'task.cancelled'
          : 'task.failed',
      { status, ...(error ? { message: error } : {}) },
    );
    this.output.release(taskId);
    this.db
      .prepare(
        "UPDATE schedule_occurrences SET status=?,reason=?,finished_at=? WHERE task_id=? AND status='running'",
      )
      .run(status, error ?? null, formatSystemTime(), taskId);
    /** 当前任务记录。 */
    const task = this.db.prepare('SELECT user_id,kind FROM tasks WHERE id=?').get(taskId);
    if (task && ['failed', 'cancelled', 'interrupted'].includes(status))
      this.logs?.record(String(task.user_id), {
        level: status === 'failed' ? 'error' : 'warning',
        source: 'task',
        event: `task.${status}`,
        message:
          status === 'failed'
            ? '后台任务执行失败'
            : status === 'cancelled'
              ? '后台任务已取消'
              : '后台任务因服务状态变化而中断',
        entity: { type: 'task', id: taskId },
        metadata: { kind: String(task.kind), status, reason: error?.slice(0, 200) ?? null },
      });
    if (task)
      for (/* 逐项处理当前模型工具调用。 */ const call of this.db
        .prepare(
          "SELECT id,name,status FROM tool_calls WHERE task_id=? AND name IN ('write_text','create_directory','move_path','delete_path','execute_command')",
        )
        .all(taskId)) {
        /** 任务结束前已经成功执行的工具数量。 */
        const succeeded = call.status === 'succeeded';
        /** 任务结束前被拒绝执行的工具数量。 */
        const denied = call.status === 'denied';
        this.logs?.record(String(task.user_id), {
          level: succeeded ? 'info' : denied ? 'warning' : 'error',
          source: call.name === 'execute_command' ? 'executor' : 'storage',
          event:
            call.name === 'execute_command'
              ? `executor.command_${String(call.status)}`
              : `storage.write_${String(call.status)}`,
          message: `${call.name === 'execute_command' ? '脚本执行' : '文件操作'}${succeeded ? '成功' : denied ? '被拒绝' : '失败'}`,
          entity: { type: 'tool', id: String(call.id) },
          metadata: { toolName: String(call.name), status: String(call.status) },
        });
      }
  }
  /** 创建一条新记录并同步当前状态。 */
  create(
    userId: string,
    conversationId: string,
    input: string,
    key: string,
    modelChoice?: DefaultModel,
  ) {
    /** 完成参数校验与快照固定后的执行数据。 */
    const prepared = transaction(this.db, () =>
      this.prepare(userId, conversationId, input, key, 'full', 'chat', undefined, modelChoice),
    );
    prepared.start();
    return prepared.taskId;
  }
  /** 创建会话摘要任务。 */
  createSummary(userId: string, conversationId: string, key: string, expectedVersion: number) {
    /** 完成参数校验与快照固定后的执行数据。 */
    const prepared = transaction(this.db, () =>
      this.prepare(
        userId,
        conversationId,
        '生成会话摘要',
        key,
        'readonly',
        'summary',
        expectedVersion,
      ),
    );
    prepared.start();
    return prepared.taskId;
  }
  // 调用方必须在事务内准备并关联业务记录，事务提交后才能调用 start。
  prepare(
    userId: string,
    conversationId: string,
    input: string,
    key: string,
    policy: ToolPolicy = 'full',
    kind: 'chat' | 'summary' = 'chat',
    expectedVersion?: number,
    modelChoice?: DefaultModel,
  ) {
    if (
      !this.db
        .prepare('SELECT id FROM conversations WHERE id=? AND user_id=?')
        .get(conversationId, userId)
    )
      throw new TaskError('会话不存在', 404);
    /** tasks 表的查询记录。 */
    const previous = this.db
      .prepare(
        'SELECT id, input, conversation_id, tool_policy,kind,context_snapshot FROM tasks WHERE user_id=? AND idempotency_key=?',
      )
      .get(userId, key);
    if (previous) {
      if (
        previous.input !== input ||
        previous.conversation_id !== conversationId ||
        previous.tool_policy !== policy ||
        previous.kind !== kind ||
        (kind === 'summary' &&
          JSON.parse(String(previous.context_snapshot)).version !== expectedVersion)
      )
        throw new TaskError('幂等键已绑定其他请求', 409);
      return { taskId: String(previous.id), /* 启动当前服务或状态订阅。 */ start() {} };
    }
    /** 当前选择的模型标识。 */
    const model = getModelConfig(this.db, userId, modelChoice);
    if (modelChoice && !model) throw new TaskError('所选模型不可用，请重新选择模型', 400);
    if (!this.providerFactory && !model) throw new TaskError('请先配置提供商并指定全局默认模型');
    if (this.registry.executor?.uncertain)
      throw new TaskError('命令清理状态不确定，请检查脚本运行环境后重启', 503);
    if (this.isBusy()) throw new TaskError('上一任务仍在运行或清理，请稍后重试', 409);
    /** 当前执行或模型上下文。 */
    const context = getConversationContext(this.db, userId, conversationId);
    if (kind === 'summary' && expectedVersion !== context.version)
      throw new TaskError('会话摘要设置已被其他操作更新，请刷新后重试', 409);
    if (kind === 'summary' && !context.remainingMessages)
      throw new TaskError('没有需要生成摘要的新消息');
    /** 当前任务标识。 */
    const taskId = randomUUID();
    /** 当前时间。 */
    const now = formatSystemTime();
    /** 当前助手配置。 */
    const assistant = getAssistant(this.db, userId);
    if (!assistant.config.onboardingCompleted && (policy !== 'full' || kind !== 'chat'))
      throw new TaskError('请先在普通对话中完成首次身份设置');
    /** 当前会话补充规则的固定快照。 */
    const conversationRules = getConversationRules(this.db, userId, conversationId);
    /** 当前任务使用的联网服务或权限会话。 */
    const web = this.web.session(userId, policy);
    this.db
      .prepare(
        'INSERT INTO tasks (id,user_id,conversation_id,status,idempotency_key,input,created_at,assistant_config_snapshot,conversation_rules_snapshot,model_snapshot,tool_policy) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        taskId,
        userId,
        conversationId,
        'queued',
        key,
        input,
        now,
        JSON.stringify(assistant),
        JSON.stringify(conversationRules),
        model
          ? JSON.stringify({
              providerId: model.providerId,
              providerName: model.providerName,
              model: model.model,
            })
          : null,
        policy,
      );
    this.db.prepare('UPDATE tasks SET kind=?,context_snapshot=? WHERE id=?').run(
      kind,
      JSON.stringify({
        version: context.version,
        autoSummary: context.autoSummary,
        throughMessageId: context.valid ? context.throughMessageId : null,
      }),
      taskId,
    );
    if (kind === 'chat')
      this.db
        .prepare('INSERT INTO messages VALUES (?,?,?,?,?)')
        .run(randomUUID(), conversationId, 'user', input, now);
    this.db
      .prepare('UPDATE tasks SET web_snapshot=? WHERE id=?')
      .run(JSON.stringify(publicWebConfig(web.config)), taskId);
    this.db
      .prepare('INSERT INTO task_skills VALUES (?,?)')
      .run(
        taskId,
        JSON.stringify(
          kind === 'summary' ? [] : this.skills.scan().skills.filter((item) => item.enabled),
        ),
      );
    this.event(taskId, 'task.queued', { status: 'queued' });
    return {
      taskId,
      start: () => {
        if (
          this.running.has(taskId) ||
          this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)?.status !== 'queued'
        )
          return;
        /** 用于主动取消当前操作的控制器。 */
        const controller = new AbortController();
        /** 等待当前异步操作完成的任务。 */
        const promise = Promise.resolve()
          .then(() => this.run(taskId, userId, conversationId, controller.signal, model, web))
          .finally(() => this.running.delete(taskId));
        this.running.set(taskId, { controller, promise });
      },
    };
  }
  /** 执行当前操作并返回执行结果。 */
  private async run(
    taskId: string,
    userId: string,
    conversationId: string,
    cancelSignal: AbortSignal,
    model: ReturnType<typeof getModelConfig>,
    web: WebSession,
  ) {
    /** 普通聊天由用户停止；无人值守的定时任务和摘要仍有总执行时限。 */
    const task = this.get(taskId, userId);
    const signal =
      task.kind === 'chat' && task.tool_policy !== 'readonly'
        ? cancelSignal
        : AbortSignal.any([cancelSignal, AbortSignal.timeout(120000)]);
    let outputError: ProviderError | undefined;
    /** 本次消息的唯一标识。 */
    const messageId = randomUUID();
    try {
      signal.throwIfAborted();
      if (!this.isActive(taskId)) return;
      this.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(taskId);
      this.event(taskId, 'task.started', { status: 'running' });
      this.output.start(taskId, conversationId, messageId, () => {
        outputError = new ProviderError('保存消息检查点失败');
        this.running.get(taskId)?.controller.abort(outputError);
      });
      /** 当前模型或联网服务提供商。 */
      const provider = this.providerFactory?.(userId) ?? new CompatibleProvider(model!);
      /** 创建任务时记录的工具权限策略。 */
      const configuredToolPolicy: ToolPolicy =
        task.tool_policy === 'readonly' ? 'readonly' : 'full';
      /** 当前助手配置。 */
      const assistant: { config: unknown; version: number } = JSON.parse(
        String(task.assistant_config_snapshot),
      );
      /** 当前流程使用的配置。 */
      const config = parseAssistant(assistant.config);
      /** 当前助手是否仍处于首次身份设置流程。 */
      const onboarding = !config.onboardingCompleted && configuredToolPolicy === 'full';
      /** 本轮模型可使用的工具权限范围。 */
      const toolPolicy: ToolPolicy = onboarding ? 'onboarding' : configuredToolPolicy;
      /** 任务创建时的初始技能目录，仅用于记录；工具读取当前磁盘文件。 */
      const skillSnapshot: Skill[] = JSON.parse(
        String(
          this.db.prepare('SELECT snapshot FROM task_skills WHERE task_id=?').get(taskId)
            ?.snapshot ?? '[]',
        ),
      );
      /** 当前可用技能列表。 */
      const skills = new SkillSession(this.db, this.skills, skillSnapshot, taskId, (type, data) => {
        signal.throwIfAborted();
        this.event(taskId, type, data);
      });
      /** 当前任务的工具注册表。 */
      const registry = new ToolRegistry(
        this.registry.workspace.root,
        this.registry.executor,
        web,
        new RetrievalSession(this.db, userId, conversationId),
        skills,
        onboarding
          ? (args) => {
              saveAssistant(
                this.db,
                userId,
                {
                  name: String(args.name),
                  emoji: String(args.emoji),
                  description: String(args.description),
                  personality: String(args.personality),
                  userName: String(args.userName),
                  language: String(args.language),
                  timezone: String(args.timezone),
                  userBackground: String(args.userBackground),
                  toolNotes: '',
                  rules: [],
                  onboardingCompleted: true,
                },
                assistant.version,
              );
              return { saved: true, message: '首次身份设置已保存' };
            }
          : undefined,
      );
      this.registerApplicationTools?.(registry, userId);
      /** 当前执行或模型上下文。 */
      let context = getConversationContext(this.db, userId, conversationId);
      /** 本次模型调用使用的助手上下文快照。 */
      const contextSnapshot: { version: number; autoSummary: boolean } = JSON.parse(
        String(task.context_snapshot),
      );
      /** 汇总当前会话内容为摘要。 */
      const summarize = async () => {
        context = await generateSummary({
          db: this.db,
          userId,
          conversationId,
          state: context,
          target: summaryTarget(this.db, conversationId, context),
          provider,
          model: model ? `${model.providerName} / ${model.model}` : null,
          signal,
          event: (type, data) => {
            signal.throwIfAborted();
            this.event(taskId, type, data);
          },
          usage: (value) => addTaskUsage(this.db, taskId, value),
        });
      };
      if (task.kind === 'summary') {
        if (context.version !== contextSnapshot.version)
          throw new ProviderError('摘要设置已经改变，请重新生成');
        await summarize();
        this.finish(taskId, 'succeeded');
        return;
      }
      /** 当前会话补充规则的固定快照。 */
      const conversationRules: { content: string } = JSON.parse(
        String(task.conversation_rules_snapshot),
      );
      const history = historyWindow(this.db, conversationId, context);
      const retainedUsers: ModelMessage[] = (context.checkpoint?.retainedUsers ?? []).map(
        (item) => ({ role: 'user', content: item.content }),
      );
      const userMessages = new Map<ModelMessage, string>();
      retainedUsers.forEach((message, index) =>
        userMessages.set(message, context.checkpoint!.retainedUsers[index]!.id),
      );
      history.messages.forEach((message, index) => {
        if (message.role === 'user') userMessages.set(message, String(history.rows[index]!.id));
      });
      /** 组装当前操作需要的数据。 */
      const build = () =>
        buildContext({
          config,
          tools: registry.definitions(toolPolicy),
          memory: memoryContext(this.db, userId, String(task.input)),
          skills: skills.catalog(),
          history: [
            ...retainedUsers,
            ...(context.checkpoint
              ? [{ role: 'user' as const, content: SUMMARY_PREFIX + context.summary }]
              : []),
            ...history.messages,
          ],
          summary: context.valid && !context.checkpoint ? context.summary : undefined,
          now: String(task.created_at),
          conversationRules: conversationRules.content,
        });
      const built = build();
      const question = built.messages.at(-1)!;
      const chatProvider = recoveringProvider(provider, (messages, recoverySignal) =>
        recoverContext({
          db: this.db,
          userId,
          conversationId,
          questionCursor: Number(history.rows.at(-1)!.cursor),
          question,
          userMessages,
          assistantMessageId: messageId,
          messages,
          provider,
          model: model ? `${model.providerName} / ${model.model}` : null,
          enabled: contextSnapshot.autoSummary,
          signal: recoverySignal,
          event: (type, data) => {
            signal.throwIfAborted();
            this.event(taskId, type, data);
          },
          usage: (value) => addTaskUsage(this.db, taskId, value),
        }),
      );
      await runAgent({
        taskId,
        db: this.db,
        provider: chatProvider,
        messages: built.messages,
        registry,
        signal,
        toolPolicy,
        responseCompleted: () => this.output.flush(taskId),
        event: (type, data) => {
          signal.throwIfAborted();
          this.event(taskId, type, data);
        },
        delta: (chunk) => {
          signal.throwIfAborted();
          this.output.append(taskId, chunk);
        },
      });
      this.finish(taskId, 'succeeded');
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      this.finish(
        taskId,
        cancelSignal.aborted && !outputError ? 'cancelled' : 'failed',
        outputError
          ? outputError.message
          : cancelSignal.aborted
            ? '用户取消任务'
            : signal.aborted
              ? '任务达到总时限'
              : error instanceof ProviderError
                ? error.message
                : '任务执行失败',
      );
    } finally {
      this.output.release(taskId);
    }
  }
  /** 取消当前执行并更新相关状态。 */
  cancel(taskId: string, userId: string) {
    this.get(taskId, userId);
    this.finish(taskId, 'cancelled', '用户取消任务');
    this.running.get(taskId)?.controller.abort();
  }
  /** 关闭当前资源或编辑界面。 */
  async close() {
    for (/* 逐项处理当前记录标识、执行。 */ const [id, run] of this.running) {
      this.finish(id, 'interrupted', '服务关闭，任务已中断');
      run.controller.abort();
    }
    await Promise.all([...this.running.values()].map((run) => run.promise));
  }
}
