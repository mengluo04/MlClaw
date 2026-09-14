<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  ChatDotRound,
  Clock,
  Collection,
  MagicStick,
  List,
  Document,
  Setting,
  Picture,
  Cpu,
  User,
  Search,
  Connection,
  FolderOpened,
  Menu,
  DArrowLeft,
  DArrowRight,
} from '@element-plus/icons-vue';
import { useChat, statusLabel } from '../stores/chat';
import { confirmAction } from '../composables/confirm';
import { mayLeave } from '../composables/dirty';
import { copyCode } from '../composables/clipboard';
import { api } from '../api';
import { useSession } from '../stores/session';
/** 共享的会话与任务状态。 */
const chat = useChat();
/** 当前用户的登录与助手状态。 */
const session = useSession();
/** 当前路由信息。 */
const route = useRoute();
/** 桌面侧栏是否折叠。 */
const collapsed = ref(false);
/** 手机导航抽屉是否打开。 */
const mobileNav = ref(false);
/** 主导航条目配置。 */
const navigation = [
  { path: '/chat', label: '对话', icon: ChatDotRound },
  { path: '/schedules', label: '定时任务', icon: Clock },
  { path: '/memories', label: '长期记忆', icon: Collection },
  { path: '/skills', label: '技能管理', icon: MagicStick },
  { path: '/files', label: '文件', icon: FolderOpened },
  { path: '/settings/models', label: '模型服务', icon: Cpu },
  { path: '/settings/assistant', label: '助手设置', icon: User },
  { path: '/settings/web', label: '联网搜索', icon: Search },
  { path: '/settings/channels', label: '消息渠道', icon: Connection },
  { path: '/history', label: '运行记录', icon: List },
  { path: '/logs', label: '系统日志', icon: Document },
  { path: '/settings/account', label: '账号安全', icon: Setting },
  { path: '/settings/appearance', label: '外观设置', icon: Picture },
];
/** 当前路由对应的导航项。 */
const activeNav = computed(
  () =>
    navigation.find((item) => route.path === item.path)?.path ??
    navigation.find((item) => item.path === '/chat' && route.path.startsWith('/chat/'))?.path ??
    '/chat',
);
/** 退出登录并清理前端会话状态。 */
const logout = async () => {
  if (
    !(await mayLeave()) ||
    (chat.hasDrafts && !(await confirmAction('退出将清除尚未发送的消息草稿，是否继续？')))
  )
    return;
  try {
    await api('/auth/logout', 'POST');
    session.clear();
  } catch {
    session.error = '退出失败，请重试';
  }
};
onMounted(() => {
  chat.start();
  document.addEventListener('click', copyCode);
});
onUnmounted(() => {
  document.removeEventListener('click', copyCode);
  chat.reset();
});
</script>
<template>
  <el-container class="app-shell">
    <aside class="app-sidebar" :class="{ collapsed }">
      <div class="sidebar-header">
        <RouterLink to="/chat" class="brand" :aria-label="session.siteName"
          ><img class="brand-mark" :src="session.siteIconUrl" alt="网站图标" /><span
            v-if="!collapsed"
            class="brand-name"
            :title="session.siteName"
            >{{ session.siteName }}</span
          ></RouterLink
        >
      </div>
      <el-menu
        class="sidebar-navigation"
        :default-active="activeNav"
        :collapse="collapsed"
        router
        aria-label="主导航"
        ><el-menu-item v-for="item in navigation" :key="item.path" :index="item.path"
          ><el-icon><component :is="item.icon" /></el-icon
          ><template #title>{{ item.label }}</template></el-menu-item
        ></el-menu
      >
      <el-menu class="sidebar-footer" aria-label="导航折叠控制">
        <el-menu-item
          index="toggle"
          class="collapse-navigation"
          :aria-label="collapsed ? '展开导航' : '收起导航'"
          :title="collapsed ? '展开导航' : '收起导航'"
          @click="collapsed = !collapsed"
        >
          <el-icon><component :is="collapsed ? DArrowRight : DArrowLeft" /></el-icon>
        </el-menu-item>
      </el-menu>
    </aside>
    <el-container class="app-body" direction="vertical">
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
          >任务记录<span v-if="chat.unread" class="unread-count">{{
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
        <RouterView />
      </main>
    </el-container>
    <el-drawer v-model="mobileNav" :title="session.siteName" direction="ltr" size="260px"
      ><template #header
        ><div class="brand">
          <img class="brand-mark" :src="session.siteIconUrl" alt="网站图标" /><span
            class="brand-name"
            :title="session.siteName"
            >{{ session.siteName }}</span
          >
        </div></template
      ><el-menu :default-active="activeNav" router @select="mobileNav = false"
        ><el-menu-item v-for="item in navigation" :key="item.path" :index="item.path"
          ><el-icon><component :is="item.icon" /></el-icon>{{ item.label }}</el-menu-item
        ></el-menu
      ></el-drawer
    >
  </el-container>
</template>
