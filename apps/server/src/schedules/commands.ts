import type { DatabaseSync } from 'node:sqlite';
import type { ScheduleInput, CommandResult } from '@mlclaw/shared';
import { Workspace, ToolError } from '../tools/files.js';
import { TaskError, type TaskManager } from '../tasks/manager.js';
import { formatSystemTime } from '../time.js';
import type { SystemLogService } from '../system-logs/service.js';
import { resolveCommand } from '../tools/command.js';

export interface CommandSpec {
  command: string;
  cwd: string;
  timeoutMs: number;
}
export class ScheduleCommands {
  /** 当前错误提示。 */
  error: string | null = null;
  /** 按标识保存的running映射。 */
  private running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  /** 文件工作区实例。 */
  readonly workspace: Workspace;
  constructor(
    private db: DatabaseSync,
    private tasks: TaskManager,
    private logs?: SystemLogService,
  ) {
    this.workspace = tasks.registry.workspace;
    tasks.externalBusy = () =>
      this.running.size > 0 || !!tasks.registry.executor?.uncertain || !!this.error;
  }
  /** 校验并构造命令执行参数。 */
  spec(input: ScheduleInput, checkFiles = true): CommandSpec {
    /** 当前操作选项。 */
    const options = input.commandOptions;
    if (
      !options ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 300000
    )
      throw new TaskError('脚本超时需在 100–300000 毫秒之间');
    try {
      if (checkFiles) resolveCommand(this.workspace, input.content.trim(), '.');
      return { command: input.content.trim(), timeoutMs: options.timeoutMs, cwd: '.' };
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      if (error instanceof ToolError) throw new TaskError(error.message);
      throw error;
    }
  }
  /** 恢复中断记录的状态，避免重放副作用。 */
  async recover() {
    this.db
      .prepare(
        "UPDATE schedule_occurrences SET status='interrupted',reason='服务重启，脚本执行已中断，不自动重放',finished_at=? WHERE status='running' AND json_extract(snapshot,'$.kind')='command'",
      )
      .run(formatSystemTime());
  }
  /** 启动当前服务或状态订阅。 */
  start(id: string, snapshot: ScheduleInput) {
    /** 测试或校验使用的预期值。 */
    const expected = this.spec(snapshot);
    /** 当前使用的脚本执行器。 */
    const client = this.tasks.registry.executor!;
    /** 用于主动取消当前操作的控制器。 */
    const controller = new AbortController();
    this.db
      .prepare(
        "UPDATE schedule_occurrences SET status='running',started_at=? WHERE id=? AND status='pending'",
      )
      .run(formatSystemTime(), id);
    this.log(id, 'info', 'schedule.command_started', '定时命令已开始执行');
    /** 等待当前异步操作完成的任务。 */
    const promise = Promise.resolve()
      .then(async () => {
        try {
          /** 本次处理结果。 */
          const result = await client.execute(
            {
              id,
              command: expected.command,
              cwd: expected.cwd,
              timeoutMs: expected.timeoutMs,
              args: [],
            },
            AbortSignal.any([controller.signal, AbortSignal.timeout(expected.timeoutMs + 10000)]),
          );
          this.finish(id, {
            ...result,
            status: controller.signal.aborted ? 'cancelled' : result.status,
          });
        } catch {
          // 清理未知时保留 running，重启必须先清理；externalBusy 持续阻止新任务。
          if (client.uncertain) {
            this.db
              .prepare('UPDATE schedule_occurrences SET reason=? WHERE id=?')
              .run('无法确认命令已停止，已禁止新任务；请检查运行环境后重启', id);
            this.log(
              id,
              'error',
              'schedule.command_cleanup_unknown',
              '定时命令清理状态未知，已禁止新任务',
            );
          }
          if (!client.uncertain)
            this.finish(id, {
              status: controller.signal.aborted ? 'cancelled' : 'failed',
              stdout: '',
              stderr: '',
              exitCode: null,
              durationMs: 0,
              reason: '脚本取消、超时或启动失败',
            });
        }
      })
      .catch(() => {
        // 执行可能已经产生副作用；结果落库失败时保留 running，等待重启清理，不能放行新任务。
        this.error = '命令结果保存失败，已禁止新任务；请检查数据库后重启';
        this.logs?.recordAll({
          level: 'error',
          source: 'schedule',
          event: 'schedule.command_storage_failed',
          message: this.error,
        });
      })
      .finally(() => this.running.delete(id));
    this.running.set(id, { controller, promise });
  }
  /** 完成当前处理并释放等待方。 */
  private finish(id: string, result: CommandResult) {
    this.db
      .prepare(
        'UPDATE schedule_occurrences SET status=?,command_result=?,reason=?,finished_at=? WHERE id=?',
      )
      .run(result.status, JSON.stringify(result), result.reason ?? null, formatSystemTime(), id);
    this.log(
      id,
      result.status === 'succeeded' ? 'info' : 'warning',
      'schedule.command_finished',
      result.status === 'succeeded' ? '定时命令执行完成' : '定时命令已停止或失败',
    );
  }
  /** 记录当前运行事件。 */
  private log(id: string, level: 'info' | 'warning' | 'error', event: string, message: string) {
    /** schedule_occurrences 表的查询记录。 */
    const row = this.db.prepare('SELECT user_id FROM schedule_occurrences WHERE id=?').get(id);
    if (row)
      this.logs?.record(String(row.user_id), {
        level,
        source: 'schedule',
        event,
        message,
        entity: { type: 'occurrence', id },
      });
  }
  /** 取消当前执行并更新相关状态。 */
  cancel(id: string) {
    this.running.get(id)?.controller.abort();
  }
  /** 关闭当前资源或编辑界面。 */
  async close() {
    for (/* 逐项处理当前处理的条目。 */ const item of this.running.values())
      item.controller.abort();
    await Promise.all([...this.running.values()].map((item) => item.promise));
  }
}
