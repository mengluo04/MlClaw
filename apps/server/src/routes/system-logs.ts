import type { FastifyInstance } from 'fastify';
import { sessionValid } from '../auth/index.js';
import type { SystemLogService } from '../system-logs/service.js';
import { SystemLogError, systemLogLevels, systemLogSources } from '../system-logs/types.js';

/** 注册系统系统日志相关 HTTP 接口及校验。 */
export const registerSystemLogs = (app: FastifyInstance, logs: SystemLogService) => {
  app.get<{ Querystring: { before?: string; level?: string; source?: string } }>(
    '/api/system-logs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            before: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
            level: { type: 'string', enum: [...systemLogLevels] },
            source: { type: 'string', enum: [...systemLogSources] },
          },
        },
      },
    },
    async (request) =>
      logs.page(request.userId, {
        before: request.query.before ? Number(request.query.before) : undefined,
        level: request.query.level,
        source: request.query.source,
      }),
  );

  app.get('/api/system-log-settings', async (request) => logs.settings(request.userId));
  app.put<{
    Body: { retentionDays: number; expectedVersion: number; logLevel?: 'info' | 'warn' | 'error' };
  }>(
    '/api/system-log-settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['retentionDays', 'expectedVersion'],
          properties: {
            logLevel: { type: 'string', enum: ['info', 'warn', 'error'] },
            retentionDays: { type: 'integer', minimum: 1, maximum: 30 },
            expectedVersion: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
      },
    },
    async (request) =>
      logs.updateSettings(
        request.userId,
        request.body.retentionDays,
        request.body.expectedVersion,
        request.body.logLevel,
      ),
  );

  /** 已建立的数据流集合。 */
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (/* 逐项处理关闭。 */ const close of streams) close();
  });
  app.get<{ Querystring: { after?: string } }>(
    '/api/system-logs/stream',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { after: { type: 'string', pattern: '^[0-9]{1,16}$' } },
        },
      },
    },
    async (request, reply) => {
      /** 当前分页游标。 */
      let cursor = Number(
        request.headers['last-event-id'] ??
          request.query.after ??
          logs.bounds(request.userId).latest,
      );
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new SystemLogError('事件游标无效');
      if (streams.size >= 2) throw new SystemLogError('系统日志事件订阅过多', 429);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders();
      reply.raw.write(': connected\n\n');
      /** 是否已经停止。 */
      let stopped = false;
      /** 当前连接已执行的保活轮次。 */
      let ticks = 0;
      /** 已校验的事件范围边界。 */
      let checkedBounds = false;
      /** 关闭当前资源或编辑界面。 */
      const close = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        streams.delete(close);
        reply.raw.end();
      };
      /** 持续消费待处理数据直到完成或取消。 */
      const pump = () => {
        if (stopped) return;
        try {
          if (!sessionValid(logs.db, request) || reply.raw.writableLength > 262144) return close();
          if (!checkedBounds) {
            checkedBounds = true;
            /** 当前记录范围的上下界。 */
            const bounds = logs.bounds(request.userId);
            if (cursor > 0 && bounds.oldest > 0 && cursor < bounds.oldest) {
              reply.raw.write(
                `id: ${bounds.latest}\nevent: logs.reset\ndata: ${JSON.stringify({ latestId: bounds.latest })}\n\n`,
              );
              cursor = bounds.latest;
            }
          }
          /** 查询返回的记录列表。 */
          const rows = logs.after(request.userId, cursor);
          for (/* 逐项处理当前数据库记录。 */ const row of rows) {
            reply.raw.write(`id: ${row.id}\nevent: log.created\ndata: ${JSON.stringify(row)}\n\n`);
            cursor = row.id;
          }
          if (++ticks % 30 === 0) reply.raw.write(': heartbeat\n\n');
        } catch {
          close();
        }
      };
      /** 延迟执行或超时控制的定时器句柄。 */
      const timer = setInterval(pump, 500);
      streams.add(close);
      reply.raw.once('close', close);
      pump();
    },
  );
};
