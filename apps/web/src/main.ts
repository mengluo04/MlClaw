import { createApp, h, watch } from 'vue';
import { ElConfigProvider } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { useSession } from './stores/session';
import App from './App.vue';
import { createPinia } from 'pinia';
import { router } from './app/router';
import './style.css';

/** 应用实例。 */
const app = createApp({
  render: () => h(ElConfigProvider, { locale: zhCn }, { default: () => h(App) }),
});
app.use(createPinia());
/** 当前用户的登录与助手状态。 */
const session = useSession();
window.addEventListener('mlclaw:expired', session.clear);
/** 初始化登录状态后挂载前端应用。 */
const bootstrap = async () => {
  await session.check();
  watch(
    () => session.user,
    (user) => {
      if (!user && router.currentRoute.value.path !== '/login') {
        void router.replace({
          path: '/login',
          query: { redirect: router.currentRoute.value.fullPath },
        });
      }
    },
  );
  app.use(router).mount('#app');
};
void bootstrap();
