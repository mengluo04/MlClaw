<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { SiteIconSettings } from '@mlclaw/shared';
import { api } from '../api';
import { useOperation } from '../composables/operation';

/** 由调用页面指定图片用途，上传流程和限制保持一致。 */
const props = defineProps<{
  title: string;
  description: string;
  endpoint: string;
  kind: 'icon' | 'avatar';
}>();
const emit = defineEmits<{ change: [value: SiteIconSettings] }>();
/** 已保存的图标与当前预览。 */
const settings = ref<SiteIconSettings>();
const preview = ref('');
const input = ref<HTMLInputElement>();
const { busy, error, notice, run } = useOperation();
/** 通过新地址通知浏览器重新获取标签页图标。 */
const apply = (value: SiteIconSettings) => {
  settings.value = value;
  preview.value = `${value.url}${value.url.includes('?') ? '&' : '?'}refresh=${Date.now()}`;
  emit('change', { ...value, url: preview.value });
};
/** 加载失败时允许重试。 */
const load = () => run(async () => apply(await api<SiteIconSettings>(props.endpoint)));
/** 选择后上传，服务端成功保存才更新当前图标。 */
const upload = async () => {
  const file = input.value?.files?.[0];
  if (!file) return;
  await run(async () => {
    if (file.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2 MB');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
      throw new Error('请选择 PNG、JPEG 或 WebP 图片');
    const image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error('读取图片失败，请重新选择'));
      reader.readAsDataURL(file);
    });
    apply(await api<SiteIconSettings>(props.endpoint, 'PUT', { image }));
    notice.value = `${props.title}已更新`;
  });
  if (input.value) input.value.value = '';
};
/** 删除自定义图片并立即恢复默认图标。 */
const reset = () =>
  run(async () => {
    apply(await api<SiteIconSettings>(props.endpoint, 'DELETE'));
    notice.value = props.kind === 'avatar' ? '已恢复默认头像' : '已恢复默认图标';
  });
onMounted(() => void load());
</script>

<template>
  <div>
    <section class="appearance-settings" :aria-label="title">
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
      <p v-if="!settings && busy" role="status">
        正在加载{{ kind === 'avatar' ? '头像' : '图标' }}…
      </p>
      <el-button v-if="!settings && error" :disabled="busy" @click="load">重新加载</el-button>
      <template v-if="settings">
        <div class="icon-preview">
          <img :src="preview" width="80" height="80" :alt="`当前${title}`" />
          <div>
            <strong
              >{{ settings.custom ? '自定义' : '默认'
              }}{{ kind === 'avatar' ? '头像' : '图标' }}</strong
            >
            <p>选择图片后自动保存，当前页面立即生效。</p>
          </div>
        </div>
        <p class="icon-help">
          支持静态 PNG、JPEG、WebP，不超过 2 MB 和 4096×4096
          像素。建议使用正方形图片，非正方形图片会保留比例并补齐透明边缘。
        </p>
        <input
          ref="input"
          class="icon-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          :aria-label="`选择${title}`"
          :disabled="busy"
          @change="upload"
        />
        <el-space wrap>
          <el-button type="primary" :loading="busy" :disabled="busy" @click="input?.click()">{{
            `${settings.custom ? '更换' : '上传'}${kind === 'avatar' ? '头像' : '图标'}`
          }}</el-button>
          <el-button :disabled="busy || !settings.custom" @click="reset">恢复默认</el-button>
        </el-space>
      </template>
    </section>
  </div>
</template>

<style scoped>
.appearance-settings {
  max-width: 640px;
}
.icon-preview {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 24px 0;
}
.icon-preview img {
  flex-shrink: 0;
  object-fit: contain;
  border: 1px solid #dceae7;
  border-radius: 16px;
  background: #f5f7fa;
}
.icon-preview p,
.icon-help {
  color: #627185;
  line-height: 1.7;
}
.icon-file-input {
  display: none;
}
</style>
