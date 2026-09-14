import { useSession } from '../stores/session';
import { mayLeave } from '../composables/dirty';
import { createRouter, createWebHashHistory } from 'vue-router';
/** 前端路由实例。 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: () => import('../views/LoginView.vue') },
    {
      path: '/',
      component: () => import('../views/HomeView.vue'),
      children: [
        { path: '', redirect: '/chat' },
        {
          path: '/chat/:id?',
          component: () => import('../views/ChatView.vue'),
          meta: { title: '对话' },
        },
        {
          path: '/schedules',
          component: () => import('../views/SchedulesView.vue'),
          meta: { title: '定时任务' },
        },
        {
          path: '/files',
          component: () => import('../views/FilesView.vue'),
          meta: { title: '文件' },
        },
        {
          path: '/memories',
          component: () => import('../views/MemoriesView.vue'),
          meta: { title: '长期记忆' },
        },
        {
          path: '/skills',
          component: () => import('../views/SkillsView.vue'),
          meta: { title: '技能管理' },
        },
        { path: '/knowledge/memories', redirect: '/memories' },
        { path: '/knowledge/skills', redirect: '/skills' },
        {
          path: '/history',
          component: () => import('../views/HistoryView.vue'),
          meta: { title: '运行记录' },
        },
        {
          path: '/logs',
          component: () => import('../views/SystemLogsView.vue'),
          meta: { title: '系统日志' },
        },
        {
          path: '/settings/models',
          component: () => import('../views/ModelsView.vue'),
          meta: { title: '模型服务' },
        },
        {
          path: '/settings/assistant',
          component: () => import('../views/AssistantView.vue'),
          meta: { title: '助手设置' },
        },
        {
          path: '/settings/web',
          component: () => import('../views/WebSearchView.vue'),
          meta: { title: '联网搜索' },
        },
        {
          path: '/settings/channels',
          component: () => import('../views/ChannelsView.vue'),
          meta: { title: '消息渠道' },
        },
        {
          path: '/settings/account',
          component: () => import('../views/AccountView.vue'),
          meta: { title: '账号安全' },
        },
        {
          path: '/settings/appearance',
          component: () => import('../views/AppearanceView.vue'),
          meta: { title: '外观设置' },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/chat' },
  ],
});

// 只允许返回已匹配的站内业务页面，避免登录页循环和外部跳转。
export const loginDestination = (value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/chat';
  /** 本次处理的目标。 */
  const target = router.resolve(value);
  return target.matched.some((record) => record.path === '/') ? target.fullPath : '/chat';
};

router.beforeEach(async (to, from) => {
  /** 当前用户的登录与助手状态。 */
  const session = useSession();
  if (session.user && to.fullPath !== from.fullPath && !(await mayLeave())) return false;
  if (!session.user && to.path !== '/login') {
    return { path: '/login', query: { redirect: to.fullPath }, replace: true };
  }
  if (session.user && to.path === '/login') return loginDestination(to.query.redirect);
});
