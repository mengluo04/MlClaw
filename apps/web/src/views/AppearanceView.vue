<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { SiteSettings } from '@mlclaw/shared';
import ImageSettings from '../components/ImageSettings.vue';
import { api } from '../api';
import { useSession } from '../stores/session';
import { useOperation } from '../composables/operation';
import { useDirtyGuard } from '../composables/dirty';
const session = useSession();
const name = ref('');
const saved = ref('');
const loaded = ref(false);
const { busy, error, notice, run } = useOperation();
useDirtyGuard(computed(() => loaded.value && name.value !== saved.value));
const applyName = (value: SiteSettings) => {
  session.updateSite(value);
  name.value = saved.value = value.name;
  loaded.value = true;
};
const load = () => run(async () => applyName(await api<SiteSettings>('/site')));
const save = (value: string) =>
  run(async () => {
    applyName(await api<SiteSettings>('/settings/site', 'PUT', { name: value.trim() }));
    notice.value = '网站名称已更新';
  });
onMounted(() => void load());
</script>
<template>
  <div class="page-content feature-panel">
    <section class="site-name-settings" aria-label="网站名称设置">
      <h2>网站名称</h2>
      <p>用于菜单、登录页和浏览器标题，与助手名称独立。名称会公开显示。</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
      <p v-if="!loaded && busy" role="status">正在加载网站名称…</p>
      <el-button v-if="!loaded && error" :disabled="busy" @click="load">重新加载网站名称</el-button>
      <el-form v-if="loaded" label-position="top" :disabled="busy" @submit.prevent="save(name)">
        <el-form-item label="网站名称">
          <el-input
            v-model="name"
            aria-label="网站名称"
            maxlength="40"
            show-word-limit
            placeholder="MlClaw"
          />
        </el-form-item>
        <el-space wrap>
          <el-button
            native-type="submit"
            type="primary"
            :loading="busy"
            :disabled="busy || !name.trim() || name.trim() === saved"
            >保存名称</el-button
          >
          <el-button :disabled="busy || saved === 'MlClaw'" @click="save('MlClaw')"
            >恢复默认名称</el-button
          >
        </el-space>
      </el-form>
    </section>
    <ImageSettings
      title="网站图标"
      description="用于菜单顶部、登录页、浏览器标签页和书签。"
      endpoint="/settings/site-icon"
      kind="icon"
      @change="session.updateSiteIcon($event.url)"
    />
  </div>
</template>
<style scoped>
.site-name-settings {
  max-width: 640px;
  margin-bottom: 32px;
}
</style>
