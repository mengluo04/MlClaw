import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { sessionValid } from '../auth/index.js';
import { iconUploadLimit, normalizeSiteIcon } from '../site/icon.js';
import {
  defaultAssistantAvatar,
  getAssistantAvatarSettings,
  saveAssistantAvatar,
} from '../assistant/avatar.js';

/** 头像读写均需要认证，并按当前会话用户归属。 */
export const registerAssistantAvatar = (app: FastifyInstance, db: DatabaseSync) => {
  app.get('/api/assistant-avatar', async (request, reply) => {
    const row = db
      .prepare('SELECT image FROM assistant_avatars WHERE user_id=?')
      .get(request.userId);
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    return row
      ? reply.type('image/png').send(Buffer.from(row.image as Uint8Array))
      : reply.type('image/svg+xml').send(defaultAssistantAvatar);
  });
  app.get('/api/settings/assistant-avatar', async (request) =>
    getAssistantAvatarSettings(db, request.userId),
  );
  app.put<{ Body: { image: string } }>(
    '/api/settings/assistant-avatar',
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
        return reply
          .code(400)
          .send({
            message: '图片无效：请选择不超过 2 MB、4096×4096 像素的静态 PNG、JPEG 或 WebP 图片',
          });
      }
      if (!sessionValid(db, request))
        return reply.code(401).send({ message: '登录已失效，请重新登录' });
      return saveAssistantAvatar(db, request.userId, image);
    },
  );
  app.delete('/api/settings/assistant-avatar', async (request) => {
    db.prepare('DELETE FROM assistant_avatars WHERE user_id=?').run(request.userId);
    return getAssistantAvatarSettings(db, request.userId);
  });
};
