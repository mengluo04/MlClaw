import Fastify, { LogController } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandRequest, CommandResult } from '@mlclaw/shared';
import { DockerRunner, type ExecutorConfig, type Runner } from './runner.js';

export async function createExecutor(config: ExecutorConfig, runner: Runner = new DockerRunner(config)) {
  if (config.token.length < 32) throw new Error('执行服务令牌至少 32 字符');
  if (config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, digest TEXT, result TEXT NOT NULL)');
  let unhealthy = false;
  for (const row of db.prepare('SELECT * FROM jobs').all()) {
    const value = JSON.parse(String(row.result)) as CommandResult;
    if (value.status === 'running') {
      try { await runner.cleanup(String(row.id)); }
      catch { unhealthy = true; }
      if (!unhealthy) db.prepare('UPDATE jobs SET result=? WHERE id=?').run(JSON.stringify({ ...value, status: 'interrupted', reason: '执行服务重启，不自动重放' }), String(row.id));
    }
  }
  const running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const app = Fastify({ logger: false, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 16384, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.addHook('onRequest', async (request, reply) => {
    const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest();
    const expected = createHash('sha256').update(`Bearer ${config.token}`).digest();
    if (!timingSafeEqual(supplied, expected)) return reply.code(401).send({ message: '执行服务认证失败' });
  });
  app.setErrorHandler((_, __, reply) => reply.code(400).send({ message: '执行请求无效' }));
  app.get('/health', async (_, reply) => reply.code(unhealthy ? 503 : 200).send({ ok: !unhealthy }));
  app.post<{ Body: CommandRequest }>('/jobs', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['id', 'command', 'cwd', 'args', 'timeoutMs'], properties: {
      id: { type: 'string', pattern: '^[a-f0-9-]{36}$' }, command: { type: 'string', minLength: 1, maxLength: 4000 }, cwd: { type: 'string', minLength: 1, maxLength: 500 },
      args: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 500 } }, timeoutMs: { type: 'integer', minimum: 100, maximum: 8000 },
    } } },
  }, async (request, reply) => {
    const body = request.body;
    const digest = createHash('sha256').update(JSON.stringify([body.command, body.cwd, body.args, body.timeoutMs])).digest('hex');
    const previous = db.prepare('SELECT * FROM jobs WHERE id=?').get(body.id);
    if (previous) {
      if (previous.digest !== digest) return reply.code(409).send({ message: '执行 ID 已绑定或已取消' });
      return JSON.parse(String(previous.result)) as CommandResult;
    }
    if (unhealthy || running.size) return reply.code(503).send({ message: '执行服务暂不可用或已有任务' });
    const initial: CommandResult = { status: 'running', stdout: '', stderr: '', exitCode: null, durationMs: 0 };
    db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(body.id, digest, JSON.stringify(initial));
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try { const result = await runner.execute(body, controller.signal); db.prepare('UPDATE jobs SET result=? WHERE id=?').run(JSON.stringify(result), body.id); }
      catch { unhealthy = true; /* 保留 running 记录，下次启动必须清理后才能继续。 */ }
    }).finally(() => running.delete(body.id));
    running.set(body.id, { controller, promise });
    return reply.code(202).send(initial);
  });
  app.get<{ Params: { id: string } }>('/jobs/:id', async (request, reply) => {
    const row = db.prepare('SELECT result FROM jobs WHERE id=?').get(request.params.id);
    if (!row) return reply.code(404).send({ message: '执行记录不存在' });
    if (unhealthy) return reply.code(503).send({ message: '执行清理状态待确认，已禁止新任务' });
    return JSON.parse(String(row.result)) as CommandResult;
  });
  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (request, reply) => {
    const id = request.params.id; if (!/^[a-f0-9-]{36}$/.test(id)) return reply.code(400).send({ message: '执行 ID 无效' });
    const run = running.get(id);
    if (run) { run.controller.abort(); await run.promise; }
    else if (!db.prepare('SELECT id FROM jobs WHERE id=?').get(id)) db.prepare('INSERT INTO jobs VALUES (?,NULL,?)').run(id, JSON.stringify({ status: 'cancelled', stdout: '', stderr: '', exitCode: null, durationMs: 0 }));
    return reply.code(unhealthy ? 503 : 200).send({ ok: !unhealthy });
  });
  app.addHook('preClose', async () => { for (const run of running.values()) run.controller.abort(); await Promise.all([...running.values()].map(run => run.promise)); });
  app.addHook('onClose', async () => { db.close(); });
  return { app, db };
}
