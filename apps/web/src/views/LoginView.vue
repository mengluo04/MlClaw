<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useSession } from '../stores/session';
import { loginDestination } from '../app/router';
/** 当前用户的登录与助手状态。 */
const session = useSession();
/** 当前路由信息。 */
const route = useRoute();
/** 前端路由实例。 */
const router = useRouter();
/** 登录用户名。 */
const username = ref('admin');
/** 当前密码输入，仅用于认证处理。 */
const password = ref('');
/** 用于校验一致性的再次输入密码。 */
const confirmPassword = ref('');
/** 操作进行中标记，用于禁用重复提交。 */
const busy = ref(false);
watch(
  () => session.user,
  (user) => {
    if (user && !busy.value) void router.replace(loginDestination(route.query.redirect));
  },
);
/** 提交登录或首次设置请求并更新会话。 */
const login = async () => {
  if (busy.value) return;
  busy.value = true;
  session.error = '';
  try {
    if (session.setupRequired) {
      if (password.value.length < 12 || password.value !== confirmPassword.value) {
        session.error = '密码需为 12–256 字符，且两次输入一致';
        return;
      }
      await api('/auth/setup', 'POST', { username: username.value, password: password.value });
      session.setupRequired = false;
    }
    session.user = (
      await api<{ username: string }>('/auth/login', 'POST', {
        username: username.value,
        password: password.value,
      })
    ).username;
    password.value = '';
    confirmPassword.value = '';
    await session.refreshConfig();
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
    /** 当前消息或提示内容。 */
    const message = cause instanceof Error ? cause.message : '登录失败，请重试';
    if (session.setupRequired) await session.check();
    session.error = message;
  } finally {
    busy.value = false;
    if (session.user) await router.replace(loginDestination(route.query.redirect));
  }
};
</script>
<template>
  <div v-if="session.checking" class="login-page">
    <el-skeleton :rows="4" animated />
  </div>
  <main v-else class="login-page">
    <div class="login-card">
      <img class="brand-mark" :src="session.siteIconUrl" alt="网站图标" />
      <h1>{{ session.siteName }}</h1>
      <p>你的个人 AI 助手</p>
      <h2>{{ session.setupRequired ? '首次设置管理员' : '登录' }}</h2>
      <p v-if="session.setupRequired">
        设置你的账号和 12–256 字符密码，用户名可使用英文字母、数字、下划线、点和短横线。
      </p>
      <el-alert
        v-if="session.error"
        :title="session.error"
        type="error"
        :closable="false"
        show-icon
      />
      <el-button v-if="!session.statusLoaded" @click="session.check()">重试连接</el-button>
      <el-form v-else label-position="top" @submit.prevent="login">
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
            :autocomplete="session.setupRequired ? 'new-password' : 'current-password'"
            maxlength="256"
            required
            show-password
        /></el-form-item>
        <el-form-item v-if="session.setupRequired" label="确认密码">
          <el-input
            v-model="confirmPassword"
            aria-label="确认密码"
            type="password"
            autocomplete="new-password"
            maxlength="256"
            show-password
            required
          />
        </el-form-item>
        <el-button
          class="login-submit"
          type="primary"
          native-type="submit"
          :loading="busy"
          :disabled="
            !username ||
            !password ||
            (session.setupRequired && (password.length < 12 || password !== confirmPassword))
          "
          >{{ session.setupRequired ? '创建账号并登录' : '登录' }}</el-button
        >
      </el-form>
    </div>
  </main>
</template>
