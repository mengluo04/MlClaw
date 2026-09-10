import { formatSystemTime } from '../time.js';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config/index.js';
import type { SystemLogService } from '../system-logs/service.js';

declare module 'fastify' {
  interface FastifyRequest { userId: string; sessionHash: string }
  interface FastifyContextConfig { publicAsset?: boolean }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(password, salt)).toString('hex')}`;
}
async function verify(password: string, hash: string): Promise<boolean> {
  const [salt, expected] = hash.split(':');
  const actual = await derive(password, salt!);
  const stored = Buffer.from(expected!, 'hex');
  return stored.length === actual.length && timingSafeEqual(stored, actual);
}
export async function initializeAdmin(db: DatabaseSync, config: Config) {
  if (db.prepare('SELECT id FROM users LIMIT 1').get()) return;
  if (!config.adminPassword || config.adminPassword.length < 12 || config.adminPassword.length > 256) throw new Error('首次启动必须设置 12–256 字符的 ADMIN_PASSWORD');
  if (!/^[\w.-]{1,64}$/.test(config.adminUsername)) throw new Error('ADMIN_USERNAME 格式无效');
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(randomUUID(), config.adminUsername, await hashPassword(config.adminPassword), formatSystemTime());
}
export function sessionValid(db: DatabaseSync, request: FastifyRequest): boolean {
  const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('mlclaw_session='))?.slice(15);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const hash = digest(token);
  const session = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hash, formatSystemTime());
  if (!session) return false;
  request.userId = String(session.user_id); request.sessionHash = hash;
  return true;
}
export function registerAuth(app: FastifyInstance, db: DatabaseSync, config: Config, logs?: SystemLogService) {
  app.decorateRequest('userId', ''); app.decorateRequest('sessionHash', '');
  const cookie = (value: string, maxAge: number) => `mlclaw_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie ? '; Secure' : ''}`;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    // 只公开由服务端显式标记的前端 GET/HEAD 路由，业务 API 仍需认证。
    if (request.routeOptions.config.publicAsset && ['GET', 'HEAD'].includes(request.method)) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== config.origin) return reply.code(403).send({ message: '请求来源不被允许' });
    if (request.routeOptions.url === '/api/health' || request.routeOptions.url === '/api/auth/login') return;
    if (!sessionValid(db, request)) return reply.code(401).send({ message: '请先登录' });
  });
  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', {
    schema: { body: { type: 'object', required: ['username', 'password'], additionalProperties: false, properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 256 } } } },
  }, async (request, reply) => {
    const now = new Date();
    db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(formatSystemTime(new Date(now.getTime() - 900000)));
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get()!.n);
    const local = Number(db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?').get(request.ip)!.n);
    if (total >= 30 || local >= 5) {
      logs?.recordAllThrottled({ level: 'warning', source: 'auth', event: 'auth.rate_limited', message: '登录尝试过多，已触发临时限制', metadata: { count: Math.max(total, local) } });
      return reply.header('Retry-After', '900').code(429).send({ message: '登录尝试过多，请稍后重试' });
    }
    db.prepare('INSERT INTO login_attempts VALUES (?, ?)').run(request.ip, formatSystemTime(now));
    const user = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(request.body.username);
    const fallback = db.prepare('SELECT password_hash FROM users LIMIT 1').get()!;
    const valid = await verify(request.body.password, String(user?.password_hash ?? fallback.password_hash));
    if (!user || !valid) return reply.code(401).send({ message: '用户名或密码错误' });
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(formatSystemTime(now));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), String(user.id), formatSystemTime(new Date(now.getTime() + config.sessionSeconds * 1000)));
    logs?.record(String(user.id), { level: 'info', source: 'auth', event: 'auth.login_succeeded', message: '管理员已登录' });
    return reply.header('Set-Cookie', cookie(token, config.sessionSeconds)).send({ username: request.body.username });
  });
  app.get('/api/auth/me', async request => db.prepare('SELECT id, username FROM users WHERE id = ?').get(request.userId));
  app.post('/api/auth/logout', async (request, reply) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(request.sessionHash);
    logs?.record(request.userId, { level: 'info', source: 'auth', event: 'auth.logout_succeeded', message: '管理员已退出登录' });
    return reply.header('Set-Cookie', cookie('', 0)).send({ ok: true });
  });
}
