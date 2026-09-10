import type { FastifyInstance } from 'fastify';
import { sessionValid } from '../auth/index.js';
import type { SystemLogService } from '../system-logs/service.js';
import { SystemLogError, systemLogLevels, systemLogSources } from '../system-logs/types.js';

export function registerSystemLogs(app: FastifyInstance, logs: SystemLogService) {
  app.get<{ Querystring: { before?: string; level?: string; source?: string } }>('/api/system-logs', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      before: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' }, level: { type: 'string', enum: [...systemLogLevels] }, source: { type: 'string', enum: [...systemLogSources] },
    } } },
  }, async request => logs.page(request.userId, { before: request.query.before ? Number(request.query.before) : undefined, level: request.query.level, source: request.query.source }));

  app.get('/api/system-log-settings', async request => logs.settings(request.userId));
  app.put<{ Body: { retentionDays: number; expectedVersion: number } }>('/api/system-log-settings', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['retentionDays', 'expectedVersion'], properties: {
      retentionDays: { type: 'integer', minimum: 1, maximum: 30 }, expectedVersion: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    } } },
  }, async request => logs.updateSettings(request.userId, request.body.retentionDays, request.body.expectedVersion));

  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of streams) close(); });
  app.get<{ Querystring: { after?: string } }>('/api/system-logs/stream', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { after: { type: 'string', pattern: '^[0-9]{1,16}$' } } } },
  }, async (request, reply) => {
    let cursor = Number(request.headers['last-event-id'] ?? request.query.after ?? logs.bounds(request.userId).latest);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new SystemLogError('事件游标无效');
    if (streams.size >= 2) throw new SystemLogError('系统日志事件订阅过多', 429);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    reply.raw.flushHeaders();
    reply.raw.write(': connected\n\n');
    let stopped = false; let ticks = 0; let checkedBounds = false;
    const close = () => { if (stopped) return; stopped = true; clearInterval(timer); streams.delete(close); reply.raw.end(); };
    const pump = () => {
      if (stopped) return;
      try {
        if (!sessionValid(logs.db, request) || reply.raw.writableLength > 262144) return close();
        if (!checkedBounds) {
          checkedBounds = true; const bounds = logs.bounds(request.userId);
          if (cursor > 0 && bounds.oldest > 0 && cursor < bounds.oldest) {
            reply.raw.write(`id: ${bounds.latest}\nevent: logs.reset\ndata: ${JSON.stringify({ latestId: bounds.latest })}\n\n`); cursor = bounds.latest;
          }
        }
        const rows = logs.after(request.userId, cursor);
        for (const row of rows) { reply.raw.write(`id: ${row.id}\nevent: log.created\ndata: ${JSON.stringify(row)}\n\n`); cursor = row.id; }
        if (++ticks % 30 === 0) reply.raw.write(': heartbeat\n\n');
      } catch { close(); }
    };
    const timer = setInterval(pump, 500); streams.add(close); reply.raw.once('close', close); pump();
  });
}
