import type { CommandRequest, CommandResult } from '@mlclaw/shared';
import { ToolError } from './files.js';
import { record } from '../providers/types.js';

export class ExecutorClient {
  uncertain = false;
  constructor(private url: string, private token: string) {}
  private async request(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) { await response.body?.cancel(); throw new ToolError('执行服务不可用，请检查独立执行服务'); }
    // 受信执行服务也必须限制响应大小。
    const reader = response.body?.getReader(); if (!reader) throw new ToolError('执行服务响应为空');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 524288) throw new ToolError('执行服务响应过大'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  async cancel(id: string) {
    try { await this.request(`/jobs/${id}/cancel`, 'POST'); }
    catch { this.uncertain = true; throw new ToolError('无法确认命令已停止，已禁止新任务；请检查执行服务后重启'); }
  }
  async execute(request: CommandRequest, signal: AbortSignal): Promise<CommandResult> {
    try {
      let result = await this.request('/jobs', 'POST', request, signal);
      while (true) {
        signal.throwIfAborted();
        if (!record(result) || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(result.status)) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || typeof result.durationMs !== 'number' || !(result.exitCode === null || Number.isInteger(result.exitCode))) throw new ToolError('执行服务返回格式无效');
        if (result.status !== 'running') return result as unknown as CommandResult;
        await new Promise<void>((resolve, reject) => {
          const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
          const timer = setTimeout(finish, 100);
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        });
        result = await this.request(`/jobs/${request.id}`, 'GET', undefined, signal);
      }
    } catch (error) { await this.cancel(request.id); if (error instanceof ToolError) throw error; throw new ToolError('命令取消、超时或执行服务连接失败'); }
  }
}
