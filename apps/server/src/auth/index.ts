import { transaction } from '../db/index.js';
import { formatSystemTime } from '../time.js';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '../config/index.js';
import type { SystemLogService } from '../system-logs/service.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    publicFrontend?: boolean;
  }
  interface FastifyRequest {
    userId: string;
    sessionHash: string;
  }
}
/** 生成内容摘要用于一致性比较。 */
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** 计算密码派生结果。 */
const derive = (password: string, salt: string): Promise<Buffer> => {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
};
/** 使用随机盐生成密码哈希。 */
export const hashPassword = async (password: string): Promise<string> => {
  /** 密码哈希使用的随机盐。 */
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(password, salt)).toString('hex')}`;
};
/** 重新派生输入密码并使用等长、恒定时间比较验证哈希。 */
const verify = async (password: string, hash: string): Promise<boolean> => {
  /** salt：密码哈希使用的随机盐；expected：密码记录中保存的十六进制派生值。 */
  const [salt, expected] = hash.split(':');
  /** 本次输入密码计算出的派生字节。 */
  const actual = await derive(password, salt!);
  /** 从数据库密码哈希中还原的派生字节。 */
  const stored = Buffer.from(expected!, 'hex');
  return stored.length === actual.length && timingSafeEqual(stored, actual);
};
/** 在尚未初始化时创建唯一管理员。 */
export const initializeAdmin = async (db: DatabaseSync, config: Config) => {
  if (db.prepare('SELECT id FROM users LIMIT 1').get()) return;
  if (!config.adminPassword) return;
  if (
    !config.adminPassword ||
    config.adminPassword.length < 12 ||
    config.adminPassword.length > 256
  )
    throw new Error('首次启动必须设置 12–256 字符的 ADMIN_PASSWORD');
  if (!/^[\w.-]{1,64}$/.test(config.adminUsername ?? 'admin'))
    throw new Error('ADMIN_USERNAME 格式无效');
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(
    randomUUID(),
    config.adminUsername ?? 'admin',
    await hashPassword(config.adminPassword),
    formatSystemTime(),
  );
};
/** 检查用户会话是否仍然有效。 */
export const sessionValid = (db: DatabaseSync, request: FastifyRequest): boolean => {
  /** 当前认证或平台访问令牌。 */
  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('mlclaw_session='))
    ?.slice(15);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  /** 用于一致性或认证校验的哈希值。 */
  const hash = digest(token);
  /** 数据库中仍未过期的认证会话。 */
  const session = db
    .prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(hash, formatSystemTime());
  if (!session) return false;
  request.userId = String(session.user_id);
  request.sessionHash = hash;
  return true;
};
/** 注册认证相关 HTTP 接口及校验。 */
export const registerAuth = (
  app: FastifyInstance,
  db: DatabaseSync,
  config: Config,
  logs?: SystemLogService,
) => {
  app.decorateRequest('userId', '');
  app.decorateRequest('sessionHash', '');
  /** 提取或构造认证 Cookie。 */
  const cookie = (value: string, maxAge: number, request: FastifyRequest) =>
    `mlclaw_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie || request.headers.origin?.startsWith('https://') ? '; Secure' : ''}`;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (request.routeOptions.config.publicFrontend && ['GET', 'HEAD'].includes(request.method))
      return;
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !allowedOrigin(request, config.origin)
    )
      return reply.code(403).send({ message: '请求来源不被允许' });
    if (
      request.routeOptions.url === '/api/health' ||
      request.routeOptions.url === '/api/auth/login' ||
      request.routeOptions.url === '/api/auth/status' ||
      request.routeOptions.url === '/api/auth/setup'
    )
      return;
    if (!sessionValid(db, request)) return reply.code(401).send({ message: '请先登录' });
  });
  /** 检查请求频率并记录当前尝试。 */
  const rateLimit = (request: FastifyRequest, reply: FastifyReply) => {
    /** 当前时间。 */
    const now = new Date();
    db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(
      formatSystemTime(new Date(now.getTime() - 900000)),
    );
    /** 累计处理量，用于容量或数量限制。 */
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get()!.n);
    /** 最近 15 分钟内当前 IP 的认证尝试次数。 */
    const local = Number(
      db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?').get(request.ip)!.n,
    );
    if (total >= 30 || local >= 5) {
      logs?.recordAllThrottled({
        level: 'warning',
        source: 'auth',
        event: 'auth.rate_limited',
        message: '登录尝试过多，已触发临时限制',
        metadata: { count: Math.max(total, local) },
      });
      reply.header('Retry-After', '900').code(429).send({ message: '认证尝试过多，请稍后重试' });
      return false;
    }
    return Number(
      db.prepare('INSERT INTO login_attempts VALUES (?, ?)').run(request.ip, formatSystemTime(now))
        .lastInsertRowid,
    );
  };
  app.get('/api/auth/status', async () => ({
    setupRequired: !db.prepare('SELECT id FROM users LIMIT 1').get(),
  }));
  /** 是否正在初始化管理员。 */
  let settingUp = false;
  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/setup',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' },
            password: { type: 'string', minLength: 12, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      if (settingUp || db.prepare('SELECT id FROM users LIMIT 1').get())
        return reply.code(409).send({ message: '管理员已设置，请登录' });
      /** 当前尝试序号。 */
      const attempt = rateLimit(request, reply);
      if (!attempt) return;
      settingUp = true;
      try {
        /** 用于一致性或认证校验的哈希值。 */
        const hash = await hashPassword(request.body.password);
        /** 当前记录标识。 */
        const id = randomUUID();
        /** 本次插入操作的结果。 */
        const inserted = db
          .prepare(
            'INSERT INTO users(id,username,password_hash,created_at) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM users)',
          )
          .run(id, request.body.username, hash, formatSystemTime());
        if (!inserted.changes) return reply.code(409).send({ message: '管理员已设置，请登录' });
        db.prepare('DELETE FROM login_attempts WHERE rowid=?').run(attempt);
        logs?.record(id, {
          level: 'info',
          source: 'auth',
          event: 'auth.initialized',
          message: '管理员账号已创建',
        });
        return { ok: true };
      } finally {
        settingUp = false;
      }
    },
  );
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/auth/password',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 256 },
            newPassword: { type: 'string', minLength: 12, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      /** 当前尝试序号。 */
      const attempt = rateLimit(request, reply);
      if (!attempt) return;
      /** 当前用户记录。 */
      const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(request.userId)!;
      /** 修改密码前的哈希，用于并发校验。 */
      const oldHash = String(user.password_hash);
      if (!(await verify(request.body.currentPassword, oldHash)))
        return reply.code(400).send({ message: '当前密码不正确' });
      /** 用于一致性或认证校验的哈希值。 */
      const hash = await hashPassword(request.body.newPassword);
      /** 本次条件更新影响的记录数或返回结果。 */
      const changed = transaction(db, () => {
        if (!sessionValid(db, request)) return false;
        /** users 表的操作结果。 */
        const result = db
          .prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?')
          .run(hash, request.userId, oldHash);
        if (!result.changes) return false;
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(request.userId);
        return true;
      });
      if (!changed) return reply.code(409).send({ message: '登录状态或密码已变化，请重新登录' });
      db.prepare('DELETE FROM login_attempts WHERE rowid=?').run(attempt);
      logs?.record(request.userId, {
        level: 'info',
        source: 'auth',
        event: 'auth.password_changed',
        message: '管理员已修改密码，所有登录已失效',
      });
      return reply.header('Set-Cookie', cookie('', 0, request)).send({ ok: true });
    },
  );
  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      /** 当前尝试序号。 */
      const attempt = rateLimit(request, reply);
      if (!attempt) return;
      /** 当前时间。 */
      const now = new Date();
      /** 当前用户记录。 */
      const user = db
        .prepare('SELECT id, password_hash FROM users WHERE username = ?')
        .get(request.body.username);
      /** 用于处理缺失值的回退数据。 */
      const fallback = db.prepare('SELECT password_hash FROM users LIMIT 1').get();
      if (!fallback) return reply.code(409).send({ message: '请先设置管理员账号' });
      /** 当前数据是否通过有效性校验。 */
      const valid = await verify(
        request.body.password,
        String(user?.password_hash ?? fallback.password_hash),
      );
      if (!user || !valid) return reply.code(401).send({ message: '用户名或密码错误' });
      // 密码验证期间可能发生改密，禁止旧密码创建新会话。
      if (
        db.prepare('SELECT password_hash FROM users WHERE id=?').get(String(user.id))
          ?.password_hash !== user.password_hash
      )
        return reply.code(401).send({ message: '密码已变化，请重新登录' });
      db.prepare('DELETE FROM login_attempts WHERE rowid=?').run(attempt);
      /** 当前认证或平台访问令牌。 */
      const token = randomBytes(32).toString('hex');
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(formatSystemTime(now));
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
        digest(token),
        String(user.id),
        formatSystemTime(new Date(now.getTime() + config.sessionSeconds * 1000)),
      );
      logs?.record(String(user.id), {
        level: 'info',
        source: 'auth',
        event: 'auth.login_succeeded',
        message: '管理员已登录',
      });
      return reply
        .header('Set-Cookie', cookie(token, config.sessionSeconds, request))
        .send({ username: request.body.username });
    },
  );
  app.get('/api/auth/me', async (request) =>
    db.prepare('SELECT id, username FROM users WHERE id = ?').get(request.userId),
  );
  app.post('/api/auth/logout', async (request, reply) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(request.sessionHash);
    logs?.record(request.userId, {
      level: 'info',
      source: 'auth',
      event: 'auth.logout_succeeded',
      message: '管理员已退出登录',
    });
    return reply.header('Set-Cookie', cookie('', 0, request)).send({ ok: true });
  });
};

/** 验证请求来源是否符合服务端同源约定。 */
const allowedOrigin = (request: FastifyRequest, override?: string): boolean => {
  /** 请求来源地址。 */
  const origin = request.headers.origin;
  if (!origin) return false;
  if (override) return origin === override;
  try {
    /** 当前请求或资源地址。 */
    const url = new URL(origin);
    // 反代保留浏览器 Host；不信任客户端可伪造的 Forwarded / X-Forwarded-*。
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin === origin &&
      url.host === request.headers.host &&
      request.headers['sec-fetch-site'] !== 'cross-site'
    );
  } catch {
    return false;
  }
};
