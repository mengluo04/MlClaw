<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../api';
import { useSession } from '../stores/session';
import { useDirtyGuard } from '../composables/dirty';
/** 当前用户的登录与助手状态。 */
const session = useSession();
/** 修改密码前验证的原密码。 */
const currentPassword = ref('');
/** 待设置的新密码。 */
const newPassword = ref('');
/** 再次输入的新密码，用于一致性校验。 */
const confirmation = ref('');
/** 操作进行中标记，用于禁用重复提交。 */
const busy = ref(false);
/** 当前错误提示。 */
const error = ref('');
useDirtyGuard(computed(() => !!(currentPassword.value || newPassword.value || confirmation.value)));
/** 校验并保存当前编辑内容。 */
const save = async () => {
  if (busy.value) return;
  if (newPassword.value.length < 12 || newPassword.value !== confirmation.value) {
    error.value = '新密码需为 12–256 字符，且两次输入一致';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api('/auth/password', 'POST', {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    currentPassword.value = newPassword.value = confirmation.value = '';
    session.clear();
    session.error = '密码已修改，请使用新密码重新登录';
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
    error.value = cause instanceof Error ? cause.message : '修改失败，请重试';
  } finally {
    busy.value = false;
  }
};
</script>
<template>
  <div class="page-content feature-panel">
    <section style="max-width: 480px">
      <h2>账号安全</h2>
      <p>当前账号：{{ session.user }}。修改密码后，所有设备都需要重新登录。</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-form label-position="top" :disabled="busy" @submit.prevent="save">
        <el-form-item label="当前密码"
          ><el-input
            v-model="currentPassword"
            aria-label="当前密码"
            type="password"
            autocomplete="current-password"
            maxlength="256"
            show-password
            required
        /></el-form-item>
        <el-form-item label="新密码"
          ><el-input
            v-model="newPassword"
            aria-label="新密码"
            type="password"
            autocomplete="new-password"
            maxlength="256"
            show-password
            required
        /></el-form-item>
        <el-form-item label="确认新密码"
          ><el-input
            v-model="confirmation"
            aria-label="确认新密码"
            type="password"
            autocomplete="new-password"
            maxlength="256"
            show-password
            required
        /></el-form-item>
        <el-button
          type="primary"
          native-type="submit"
          :loading="busy"
          :disabled="!currentPassword || newPassword.length < 12 || newPassword !== confirmation"
          >修改密码</el-button
        >
      </el-form>
    </section>
  </div>
</template>
