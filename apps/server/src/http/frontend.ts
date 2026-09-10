import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

// 仅使用构建目录；不允许通过环境变量把数据库或工作目录设成公开目录。
const webRoot = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
export function registerFrontend(app: FastifyInstance, root = webRoot) {
  app.register(async scope => {
    await access(join(root, 'index.html'));
    await scope.register(fastifyStatic, { root, serve: false, dotfiles: 'deny', cacheControl: false });
    for (const url of ['/', '/index.html']) {
      scope.get(url, { config: { publicAsset: true } }, async (_request, reply) => reply.sendFile('index.html'));
    }
    // Vue 使用 hash 路由，不需要将未知 API 或文件请求回退成首页。
    scope.get<{ Params: { file: string } }>('/assets/:file', { config: { publicAsset: true } }, async (request, reply) => {
      const file = request.params.file;
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|css|woff2?|ttf|svg|png|jpe?g|webp|gif|ico)$/.test(file)) return reply.code(404).send({ message: '文件不存在' });
      return reply.header('Cache-Control', 'public, max-age=31536000, immutable').sendFile(file, join(root, 'assets'));
    });
  });
}
