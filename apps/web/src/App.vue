<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import {
  ChatDotRound,
  Clock,
  Collection,
  List,
  Document,
  Setting,
  Menu,
  ArrowLeft,
  ArrowRight,
} from "@element-plus/icons-vue";
import { useChat, statusLabel } from "./stores/chat";
import { confirmAction } from "./composables/confirm";
import { mayLeave } from "./composables/dirty";
import { copyCode } from "./composables/clipboard";
import { api } from "./api";
import { useSession } from "./stores/session";
const chat = useChat();
const session = useSession();
const route = useRoute();
const collapsed = ref(false);
const username = ref("admin");
const password = ref("");
const busy = ref(false);
const mobileNav = ref(false);
const navigation = [
  { path: "/chat", label: "对话", icon: ChatDotRound },
  { path: "/schedules", label: "定时任务", icon: Clock },
  { path: "/knowledge/memories", label: "记忆与技能", icon: Collection },
  { path: "/history", label: "运行记录", icon: List },
  { path: "/logs", label: "系统日志", icon: Document },
  { path: "/settings/models", label: "设置", icon: Setting },
];
const activeNav = computed(
  () =>
    navigation.find(
      (item) => route.path.split("/")[1] === item.path.split("/")[1],
    )?.path ?? "/chat",
);
async function login() {
  if (busy.value) return;
  busy.value = true;
  session.error = "";
  try {
    session.user = (
      await api<{ username: string }>("/auth/login", "POST", {
        username: username.value,
        password: password.value,
      })
    ).username;
    password.value = "";
    await session.refreshConfig();
  } catch (cause) {
    session.error = cause instanceof Error ? cause.message : "登录失败，请重试";
  } finally {
    busy.value = false;
  }
}
async function logout() {
  if (
    !(await mayLeave()) ||
    (chat.hasDrafts &&
      !(await confirmAction("退出将清除尚未发送的消息草稿，是否继续？")))
  )
    return;
  try {
    await api("/auth/logout", "POST");
    session.clear();
  } catch {
    session.error = "退出失败，请重试";
  }
}
watch(
  () => session.user,
  (user) => {
    if (user) chat.start();
    else chat.reset();
  },
);
window.addEventListener("mlclaw:expired", session.clear);
onMounted(() => {
  void session.check();
  document.addEventListener("click", copyCode);
});
onUnmounted(() => {
  document.removeEventListener("click", copyCode);
  window.removeEventListener("mlclaw:expired", session.clear);
  chat.reset();
});
</script>
<template>
  <el-config-provider :locale="zhCn">
    <div v-if="session.checking" class="login-page">
      <el-skeleton :rows="4" animated />
    </div>
    <main v-else-if="!session.user" class="login-page">
      <div class="login-card">
        <span class="brand-mark">M</span>
        <h1>MlClaw</h1>
        <p>你的个人 AI 助手</p>
        <h2>登录</h2>
        <el-alert
          v-if="session.error"
          :title="session.error"
          type="error"
          :closable="false"
          show-icon
        />
        <el-form label-position="top" @submit.prevent="login">
          <el-form-item label="用户名"
            ><el-input
              v-model="username"
              aria-label="用户名"
              autocomplete="username"
              maxlength="64"
              required
          /></el-form-item>
          <el-form-item label="密码"
            ><el-input
              v-model="password"
              aria-label="密码"
              type="password"
              autocomplete="current-password"
              maxlength="256"
              required
              show-password
          /></el-form-item>
          <el-button
            class="login-submit"
            type="primary"
            native-type="submit"
            :loading="busy"
            :disabled="!username || !password"
            >登录</el-button
          >
        </el-form>
      </div>
    </main>
    <el-container v-else class="app-shell">
      <aside class="app-sidebar" :class="{ collapsed }">
        <RouterLink to="/chat" class="brand"
          ><span class="brand-mark">M</span
          ><span v-if="!collapsed">MlClaw</span></RouterLink
        >
        <el-menu
          :default-active="activeNav"
          :collapse="collapsed"
          :collapse-transition="false"
          router
          aria-label="主导航"
          ><el-menu-item
            v-for="item in navigation"
            :key="item.path"
            :index="item.path"
            ><el-icon><component :is="item.icon" /></el-icon
            ><span>{{ item.label }}</span></el-menu-item
          ></el-menu
        >
        <div v-if="!collapsed" class="sidebar-caption">你的个人助手</div>
        <el-button
          class="collapse-navigation"
          text
          :icon="collapsed ? ArrowRight : ArrowLeft"
          :aria-label="collapsed ? '展开导航' : '收起导航'"
          @click="collapsed = !collapsed"
        />
      </aside>
      <el-container class="app-body">
        <header class="app-header">
          <el-button
            class="mobile-menu"
            :icon="Menu"
            aria-label="打开导航"
            @click="mobileNav = true"
          /><strong>{{ route.meta.title }}</strong
          ><span class="header-spacer" /><RouterLink
            v-if="chat.runtime"
            :to="`/chat/${chat.runtime.conversationId}`"
            class="runtime-link"
            >{{ statusLabel(chat.runtime.status) }} · 查看任务</RouterLink
          ><RouterLink to="/schedules?tab=history" class="reminders-link"
            >提醒<span v-if="chat.unread" class="unread-count">{{
              chat.unread
            }}</span></RouterLink
          ><span class="account-name">{{ session.user }}</span
          ><el-button text @click="logout">退出登录</el-button>
        </header>
        <el-alert
          v-if="session.error"
          :title="session.error"
          type="error"
          show-icon
          @close="session.error = ''"
        />
        <main class="app-main">
          <RouterView v-slot="{ Component }"
            ><component
              :is="Component"
              :key="
                route.meta.panel === 'settings' ||
                route.meta.panel === 'knowledge'
                  ? route.path
                  : route.meta.panel
              "
          /></RouterView>
        </main>
      </el-container>
      <el-drawer v-model="mobileNav" title="MlClaw" direction="ltr" size="260px"
        ><el-menu :default-active="activeNav" router @select="mobileNav = false"
          ><el-menu-item
            v-for="item in navigation"
            :key="item.path"
            :index="item.path"
            ><el-icon><component :is="item.icon" /></el-icon
            >{{ item.label }}</el-menu-item
          ></el-menu
        ></el-drawer
      >
    </el-container>
  </el-config-provider>
</template>
