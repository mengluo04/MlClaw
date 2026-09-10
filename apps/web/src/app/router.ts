import { mayLeave } from "../composables/dirty";
import { createRouter, createWebHashHistory } from "vue-router";
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    {
      path: "/chat/:id?",
      component: () => import("../views/ChatView.vue"),
      meta: { title: "对话" },
    },
    {
      path: "/schedules",
      component: () => import("../views/PanelView.vue"),
      meta: { title: "定时任务", panel: "schedules" },
    },
    {
      path: "/files",
      component: () => import("../views/PanelView.vue"),
      meta: { title: "文件", panel: "files" },
    },
    {
      path: "/knowledge/:tab(memories|skills)",
      component: () => import("../views/PanelView.vue"),
      meta: { title: "记忆与技能", panel: "knowledge" },
    },
    {
      path: "/history",
      component: () => import("../views/PanelView.vue"),
      meta: { title: "运行记录", panel: "history" },
    },
    {
      path: "/logs",
      component: () => import("../views/PanelView.vue"),
      meta: { title: "系统日志", panel: "logs" },
    },
    {
      path: "/settings/:tab(models|assistant|web|channels)",
      component: () => import("../views/PanelView.vue"),
      meta: { title: "设置", panel: "settings" },
    },
    { path: "/:pathMatch(.*)*", redirect: "/chat" },
  ],
});

router.beforeEach(
  async (to, from) => to.fullPath === from.fullPath || (await mayLeave()),
);
