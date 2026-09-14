import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolRegistry } from '../tools/registry.js';
import { AssistantError, expectedVersion, parseAssistant } from '../assistant/config.js';
import { getAssistant, saveAssistant } from '../assistant/store.js';
import { buildContext } from '../agent/context.js';
import { memoryContext } from '../memory/index.js';
import { record } from '../providers/types.js';
import { assistantTemplates } from '../assistant/templates.js';

/** 注册助手相关 HTTP 接口及校验。 */
export const registerAssistant = (
  app: FastifyInstance,
  db: DatabaseSync,
  registry: (userId: string) => ToolRegistry,
) => {
  app.get('/api/settings/assistant/templates', async () => assistantTemplates());
  app.get('/api/settings/assistant', async (request) => getAssistant(db, request.userId));
  app.put('/api/settings/assistant', async (request) => {
    if (
      !record(request.body) ||
      Object.keys(request.body).some((key) => !['config', 'expectedVersion'].includes(key))
    )
      throw new AssistantError('保存参数无效');
    /** 当前流程使用的配置。 */
    const config = parseAssistant(request.body.config);
    if (!config.onboardingCompleted) throw new AssistantError('保存助手配置时必须完成身份设置');
    buildContext({
      config,
      tools: registry(request.userId).definitions(),
      skills: registry(request.userId).skills?.catalog(),
      memory: memoryContext(db, request.userId),
    });
    return saveAssistant(db, request.userId, config, expectedVersion(request.body.expectedVersion));
  });
  app.post('/api/settings/assistant/preview', async (request) => {
    if (!record(request.body) || Object.keys(request.body).some((key) => key !== 'config'))
      throw new AssistantError('预览参数无效');
    /** 当前流程使用的配置。 */
    const config = parseAssistant(request.body.config);
    /** 当前可用工具集合。 */
    const tools = registry(request.userId);
    return buildContext({
      config,
      tools: tools.definitions(config.onboardingCompleted ? 'full' : 'onboarding'),
      skills: config.onboardingCompleted ? tools.skills?.catalog() : undefined,
      memory: memoryContext(db, request.userId),
    }).preview;
  });
};
