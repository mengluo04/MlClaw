import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolRegistry } from '../tools/registry.js';
import { AssistantError } from '../assistant/config.js';
import { getAssistant } from '../assistant/store.js';
import {
  getConversationRules,
  parseConversationContent,
  saveConversationRules,
} from '../assistant/conversation.js';
import { buildContext } from '../agent/context.js';
import { memoryContext } from '../memory/index.js';
import { record } from '../providers/types.js';

/** 注册会话规则集合相关 HTTP 接口及校验。 */
export const registerConversationRules = (
  app: FastifyInstance,
  db: DatabaseSync,
  registry: (userId: string) => ToolRegistry,
) => {
  app.get<{ Params: { id: string } }>('/api/conversations/:id/rules', async (request) =>
    getConversationRules(db, request.userId, request.params.id),
  );
  app.put<{ Params: { id: string } }>('/api/conversations/:id/rules', async (request) => {
    getConversationRules(db, request.userId, request.params.id);
    if (
      !record(request.body) ||
      Object.keys(request.body).some((key) => !['content', 'expectedVersion'].includes(key))
    )
      throw new AssistantError('会话规则参数无效');
    /** 当前记录的正文内容。 */
    const content = parseConversationContent(request.body.content);
    /** 当前流程使用的配置。 */
    const config = getAssistant(db, request.userId).config;
    /** 当前可用工具集合。 */
    const tools = registry(request.userId);
    buildContext({
      config,
      tools: tools.definitions(config.onboardingCompleted ? 'full' : 'onboarding'),
      skills: config.onboardingCompleted ? tools.skills?.catalog() : undefined,
      memory: memoryContext(db, request.userId),
      conversationRules: content,
    });
    return saveConversationRules(
      db,
      request.userId,
      request.params.id,
      content,
      request.body.expectedVersion,
    );
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/rules/preview', async (request) => {
    getConversationRules(db, request.userId, request.params.id);
    if (!record(request.body) || Object.keys(request.body).some((key) => key !== 'content'))
      throw new AssistantError('会话规则预览参数无效');
    /** 当前流程使用的配置。 */
    const config = getAssistant(db, request.userId).config;
    /** 当前可用工具集合。 */
    const tools = registry(request.userId);
    return buildContext({
      config,
      tools: tools.definitions(config.onboardingCompleted ? 'full' : 'onboarding'),
      skills: config.onboardingCompleted ? tools.skills?.catalog() : undefined,
      memory: memoryContext(db, request.userId),
      conversationRules: parseConversationContent(request.body.content),
    }).preview;
  });
};
