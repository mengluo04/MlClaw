import { ModelSettingsError } from './models/store.js';
import { registerScheduleTools } from './tools/schedules.js';
import Fastify, { LogController } from 'fastify';
import { openDatabase } from './db/index.js';
import { initializeAdmin, registerAuth } from './auth/index.js';
import { registerSettings } from './routes/settings.js';
import type { Config } from './config/index.js';
import type { Provider } from './providers/types.js';
import { TaskManager, TaskError } from './tasks/manager.js';
import { registerChat } from './routes/chat.js';
import { registerPages } from './routes/pages.js';
import { ScheduleCommands } from './schedules/commands.js';
import { registerWorkspace } from './routes/workspace.js';
import { assertPrivateStorage } from './config/paths.js';
import { registerAssistant } from './routes/assistant.js';
import { AssistantError } from './assistant/config.js';
import { ProviderError } from './providers/types.js';
import { ChannelManager } from './channels/manager.js';
import { WeixinLogin } from './channels/login.js';
import { WeixinApi } from './channels/weixin.js';
import { ChannelError, type TransportFactory } from './channels/types.js';
import { registerChannels } from './routes/channels.js';
import { registerConversationRules } from './routes/conversation-rules.js';
import { ScheduleManager, type SchedulerOptions } from './schedules/manager.js';
import { registerSchedules } from './routes/schedules.js';
import { WebService } from './web/service.js';
import type { DirectFetch } from './web/fetch.js';
import { WebError } from './web/types.js';
import { registerWeb } from './routes/web.js';
import { registerRetrieval } from './routes/retrieval.js';
import { RetrievalError } from './retrieval/search.js';
import { registerSummary } from './routes/summary.js';
import { registerSkills } from './routes/skills.js';
import { SystemLogError } from './system-logs/types.js';
import { SystemLogService } from './system-logs/service.js';
import { registerSystemLogs } from './routes/system-logs.js';
import { registerFrontend } from './routes/frontend.js';
import { registerSite } from './routes/site.js';
import { registerAssistantAvatar } from './routes/assistant-avatar.js';
/** 组装数据库、服务与路由，创建 Fastify 应用。 */
export const createApp = async (
  config: Config,
  logger = false,
  providerFactory?: (userId: string) => Provider,
  channelOptions?: { factory?: TransportFactory; weixinApi?: WeixinApi },
  schedulerOptions?: SchedulerOptions,
  webRequest?: typeof fetch,
  directWebFetch?: DirectFetch,
) => {
  assertPrivateStorage(config.workspacePath ?? 'workspace', config.databasePath);
  /** 当前数据库连接。 */
  const db = openDatabase(config.databasePath);
  try {
    await initializeAdmin(db, config);
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
    db.close();
    throw error;
  }
  /** 应用实例。 */
  const app = Fastify({
    logger: logger
      ? {
          level: config.logLevel ?? 'info',
          redact: ['req.headers.authorization', 'req.headers.cookie', 'apiKey', 'secret', 'token'],
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  /** 系统活动记录服务。 */
  const logs = new SystemLogService(db, app.log);
  app.setErrorHandler((error, request, reply) => {
    /** 当前业务状态。 */
    const status =
      error instanceof ProviderError
        ? 400
        : error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
          ? error.statusCode
          : 500;
    if (status >= 500) {
      request.log.error({ requestId: request.id, err: error }, '请求处理失败');
      if (request.userId)
        logs.record(request.userId, {
          level: 'error',
          source: 'system',
          event: 'system.request_failed',
          message: '服务处理请求时发生内部错误',
          metadata: { statusCode: status },
        });
    }
    reply.code(status).send({
      message:
        error instanceof TaskError ||
        error instanceof AssistantError ||
        error instanceof ModelSettingsError ||
        error instanceof ProviderError ||
        error instanceof ChannelError ||
        error instanceof WebError ||
        error instanceof RetrievalError ||
        error instanceof SystemLogError
          ? error.message
          : status < 500
            ? '请求参数或格式无效'
            : '服务暂时无法处理请求',
    });
  });
  registerAuth(app, db, config, logs);
  registerFrontend(app);
  app.addHook('onResponse', async (request, reply) => {
    if (!request.userId || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    /** 当前路由信息。 */
    const route = request.routeOptions.url ?? '';
    /** 内部值到响应状态或业务对象的映射。 */
    const mapping =
      route === '/api/settings/web/test'
        ? {
            source: 'web' as const,
            event: 'web.connection_tested',
            message: '联网搜索连接测试已完成',
          }
        : route.startsWith('/api/settings/providers') && route.endsWith('/test')
          ? {
              source: 'model' as const,
              event: 'model.connection_tested',
              message: '模型服务连接测试已完成',
            }
          : route.startsWith('/api/settings/providers') || route === '/api/settings/model-default'
            ? {
                source: 'model' as const,
                event: 'model.settings_changed',
                message: '模型服务配置已修改',
              }
            : route === '/api/settings/web'
              ? {
                  source: 'web' as const,
                  event: 'web.settings_changed',
                  message: '联网搜索配置已修改',
                }
              : null;
    if (mapping && reply.statusCode < 400)
      logs.record(request.userId, {
        level: 'info',
        ...mapping,
        metadata: { operation: request.method },
      });
    if (route.endsWith('/test') && reply.statusCode >= 500)
      logs.record(request.userId, {
        level: 'error',
        source: route.includes('/web/') ? 'web' : 'model',
        event: route.includes('/web/')
          ? 'web.connection_test_failed'
          : 'model.connection_test_failed',
        message: route.includes('/web/') ? '联网搜索连接测试失败' : '模型服务连接测试失败',
        metadata: { statusCode: reply.statusCode },
      });
  });
  app.get('/api/health', async () => ({
    status: 'ok',
    application: 'MlClaw',
    applicationId: 'vip.mengluo.mlclaw',
  }));
  registerSettings(app, db);
  registerSite(app, db);
  registerAssistantAvatar(app, db);
  /** 当前任务使用的联网服务或权限会话。 */
  const web = new WebService(db, webRequest, directWebFetch);
  registerWeb(app, db, web);
  /** 当前任务集合或管理器。 */
  let tasks: TaskManager;
  try {
    tasks = new TaskManager(db, providerFactory, config.workspacePath, undefined, web, logs);
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
    db.close();
    throw error;
  }
  registerChat(app, db, tasks);
  registerPages(app, db);
  registerAssistant(app, db, (userId) => tasks.registryFor(userId));
  registerConversationRules(app, db, (userId) => tasks.registryFor(userId));
  registerWorkspace(app, db, tasks);
  registerRetrieval(app, db);
  registerSummary(app, db, tasks);
  registerSkills(app, tasks.skills);
  /** 当前渠道集合或管理器。 */
  const channels = new ChannelManager(db, tasks, channelOptions?.factory, logs);
  /** 微信扫码登录管理器。 */
  const channelLogin = new WeixinLogin(channels, channelOptions?.weixinApi);
  registerChannels(app, channels, channelLogin);
  /** 当前计划集合或调度器。 */
  let schedules: ScheduleManager;
  /** 定时命令的执行与取消管理器。 */
  const scheduleCommands = new ScheduleCommands(db, tasks, logs);
  try {
    await scheduleCommands.recover();
    schedules = new ScheduleManager(
      db,
      tasks,
      {
        ...schedulerOptions,
        onError: (error) => {
          app.log.error({ err: error }, '定时调度失败，请检查数据库状态');
          schedulerOptions?.onError?.(error);
        },
      },
      logs,
      scheduleCommands,
    );
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
    db.close();
    throw error;
  }
  tasks.registerApplicationTools = (registry, userId) =>
    registerScheduleTools(registry, schedules, channels, userId);
  registerSchedules(app, schedules);
  registerSystemLogs(app, logs);
  /** 延迟清理资源的定时器。 */
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => {
    logs.cleanup();
    logs.recordAll({
      level: 'info',
      source: 'system',
      event: 'system.started',
      message: 'MlClaw 服务已启动',
    });
    cleanupTimer = setInterval(() => logs.cleanup(), 86400000);
    cleanupTimer.unref();
    channels.start();
    schedules.start();
  });
  app.addHook('preClose', async () => {
    clearInterval(cleanupTimer);
    logs.recordAll({
      level: 'info',
      source: 'system',
      event: 'system.stopping',
      message: 'MlClaw 服务正在正常关闭',
    });
    web.close();
    schedules.close();
    await scheduleCommands.close();
    await channelLogin.close();
    await channels.close();
    await tasks.close();
  });
  app.addHook('onClose', async () => {
    db.close();
  });
  return { app, db, tasks, channels, channelLogin, schedules, logs };
};
