import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { sessionValid } from '../auth/index.js';
import {
  getSiteIconSettings,
  iconUploadLimit,
  normalizeSiteIcon,
  saveSiteIcon,
} from '../site/icon.js';

/** 网站图标公开展示，设置接口仍使用登录与来源校验。 */
export const registerSite = (app: FastifyInstance, db: DatabaseSync) => {
  app.get('/api/site', { config: { publicFrontend: true } }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const row = db
      .prepare(
        'SELECT name FROM site_settings WHERE user_id=(SELECT id FROM users ORDER BY created_at,id LIMIT 1)',
      )
      .get();
    return { name: row?.name ?? 'MlClaw' };
  });
  app.put<{ Body: { name: string } }>(
    '/api/settings/site',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!name || /[\u0000-\u001f\u007f]/u.test(name))
        return reply.code(400).send({ message: '网站名称需为 1–40 个字符，不能包含控制字符' });
      db.prepare(
        'INSERT INTO site_settings(user_id,name) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name',
      ).run(request.userId, name);
      return { name };
    },
  );
  app.get('/api/site-icon', { config: { publicFrontend: true } }, async (_request, reply) => {
    const row = db
      .prepare(
        'SELECT image FROM site_icons WHERE user_id=(SELECT id FROM users ORDER BY created_at,id LIMIT 1)',
      )
      .get();
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (!row) return reply.redirect('/favicon.svg');
    return reply.type('image/png').send(Buffer.from(row.image as Uint8Array));
  });
  app.get('/api/settings/site-icon', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return getSiteIconSettings(db, request.userId);
  });
  app.put<{ Body: { image: string } }>(
    '/api/settings/site-icon',
    {
      bodyLimit: Math.ceil(iconUploadLimit / 3) * 4 + 1024,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['image'],
          properties: {
            image: { type: 'string', minLength: 1, maxLength: Math.ceil(iconUploadLimit / 3) * 4 },
          },
        },
      },
    },
    async (request, reply) => {
      let image: Buffer;
      try {
        image = await normalizeSiteIcon(request.body.image);
      } catch {
        return reply.code(400).send({
          message: '图片无效：请选择不超过 2 MB、4096×4096 像素的静态 PNG、JPEG 或 WebP 图片',
        });
      }
      // 图片异步处理期间会话可能被撤销，写入前重新校验。
      if (!sessionValid(db, request))
        return reply.code(401).send({ message: '登录已失效，请重新登录' });
      return saveSiteIcon(db, request.userId, image);
    },
  );
  app.delete('/api/settings/site-icon', async (request) => {
    db.prepare('DELETE FROM site_icons WHERE user_id=?').run(request.userId);
    return getSiteIconSettings(db, request.userId);
  });
};
