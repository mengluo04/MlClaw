import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolRegistry } from '../tools/registry.js';
import { AssistantError } from '../assistant/config.js';
import { getAssistant } from '../assistant/store.js';
import { getConversationRules, parseConversationContent, saveConversationRules } from '../assistant/conversation.js';
import { buildContext } from '../agent/context.js';
import { memoryContext } from '../memory/index.js';
import { record } from '../providers/types.js';

export function registerConversationRules(app: FastifyInstance, db: DatabaseSync, registry: (userId: string) => ToolRegistry) {
  app.get<{ Params: { id: string } }>('/api/conversations/:id/rules', async request => getConversationRules(db, request.userId, request.params.id));
  app.put<{ Params: { id: string } }>('/api/conversations/:id/rules', async request => {
    getConversationRules(db, request.userId, request.params.id);
    if (!record(request.body) || Object.keys(request.body).some(key => !['content', 'expectedVersion'].includes(key))) throw new AssistantError('会话规则参数无效');
    const content = parseConversationContent(request.body.content);
    buildContext({ config: getAssistant(db, request.userId).config, tools: registry(request.userId).definitions(), skills: registry(request.userId).skills?.catalog(), memory: memoryContext(db, request.userId), conversationRules: content });
    return saveConversationRules(db, request.userId, request.params.id, content, request.body.expectedVersion);
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/rules/preview', async request => {
    getConversationRules(db, request.userId, request.params.id);
    if (!record(request.body) || Object.keys(request.body).some(key => key !== 'content')) throw new AssistantError('会话规则预览参数无效');
    return buildContext({ config: getAssistant(db, request.userId).config, tools: registry(request.userId).definitions(), skills: registry(request.userId).skills?.catalog(), memory: memoryContext(db, request.userId), conversationRules: parseConversationContent(request.body.content) }).preview;
  });
}
