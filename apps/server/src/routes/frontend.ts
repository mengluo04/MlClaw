import fastifyStatic from '@fastify/static';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** 前端构建产物目录。 */
const buildRoot = fileURLToPath(new URL('../public/', import.meta.url));

/** 注册前端资源相关 HTTP 接口及校验。 */
export const registerFrontend = (app: FastifyInstance, root = buildRoot) => {
  app.register(async (frontend) => {
    await frontend.register(fastifyStatic, { root, serve: false, cacheControl: false });
    /** 发送前端静态文件并设置对应响应类型。 */
    const send = async (file: string, reply: FastifyReply) => {
      if (file.split(/[\\/]/).some((part) => part.startsWith('.')))
        return reply.code(404).send({ message: '文件不存在' });
      try {
        /** 解析链接后的真实工作区根目录。 */
        const canonicalRoot = await realpath(root);
        /** 本次处理的目标。 */
        const target = await realpath(resolve(root, file));
        /** 当前操作使用的路径。 */
        const path = relative(canonicalRoot, target);
        if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
          return reply.code(404).send({ message: '文件不存在' });
        if (!(await stat(target)).isFile()) return reply.code(404).send({ message: '文件不存在' });
        return reply.sendFile(file);
      } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
        if (
          error instanceof Error &&
          'code' in error &&
          ['ENOENT', 'ENOTDIR'].includes(String(error.code))
        )
          return reply.code(file === 'index.html' ? 503 : 404).send({
            message:
              file === 'index.html'
                ? '前端尚未构建，请在项目根目录执行 npm run build'
                : '文件不存在',
          });
        throw error;
      }
    };
    /** 当前操作选项。 */
    const options = { config: { publicFrontend: true } };
    frontend.get('/', options, (_request, reply) => send('index.html', reply));
    frontend.get('/index.html', options, (_request, reply) => send('index.html', reply));
    frontend.get('/favicon.svg', options, (_request, reply) => send('favicon.svg', reply));
    frontend.get<{ Params: { '*': string } }>('/assets/*', options, (request, reply) =>
      send(`assets/${request.params['*']}`, reply),
    );
  });
};
