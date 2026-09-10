<script setup lang="ts">
import { useDirtyGuard } from "../composables/dirty";
import { confirmAction } from "../composables/confirm";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { WebSettings, WebConnectionTest } from "@mlclaw/shared";
import { api, ApiError } from "../api";

const emit = defineEmits<{ expired: []; dirty: [value: boolean] }>();
const loaded = ref(false);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const saved = ref<WebSettings | null>(null);
const provider = ref<WebSettings["provider"]>("tavily");
const enabled = ref(false);
const allowFetch = ref(true);
const allowSchedules = ref(false);
const apiKey = ref("");
const clearKey = ref(false);
const original = ref("");
const draft = () =>
  JSON.stringify([
    provider.value,
    enabled.value,
    allowFetch.value,
    allowSchedules.value,
  ]);
const dirty = computed(
  () =>
    loaded.value &&
    (draft() !== original.value || !!apiKey.value || clearKey.value),
);
// 草稿保留在页面内；刷新或退出登录时提示。
watch(dirty, (value) => emit("dirty", value));
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
function apply(value: WebSettings) {
  saved.value = value;
  provider.value = value.provider;
  enabled.value = value.enabled;
  allowFetch.value = value.allowFetch;
  allowSchedules.value = value.allowSchedules;
  apiKey.value = "";
  clearKey.value = false;
  original.value = draft();
  loaded.value = true;
}
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) emit("expired");
    error.value = cause instanceof Error ? cause.message : "操作失败，请重试";
  } finally {
    busy.value = false;
  }
}
async function load() {
  if (
    dirty.value &&
    !(await confirmAction("重新加载将丢弃未保存的联网配置，是否继续？"))
  )
    return;
  await action(async () => apply(await api<WebSettings>("/settings/web")));
}
async function save() {
  await action(async () => {
    apply(
      await api<WebSettings>("/settings/web", "PUT", {
        provider: provider.value,
        enabled: enabled.value,
        allowFetch: allowFetch.value,
        allowSchedules: allowSchedules.value,
        expectedVersion: saved.value!.version,
        ...(clearKey.value
          ? { apiKey: "" }
          : apiKey.value
            ? { apiKey: apiKey.value }
            : {}),
      }),
    );
    notice.value = "联网配置已保存，无需重启；新任务使用新配置。";
  });
}
async function test() {
  await action(async () => {
    const result = await api<WebConnectionTest>("/settings/web/test", "POST", {
      expectedVersion: saved.value!.version,
    });
    notice.value = `联网连接成功，用时 ${result.durationMs} 毫秒，返回 ${result.resultCount} 条结果。`;
  });
}
onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  void load();
});
onUnmounted(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  emit("dirty", false);
});

useDirtyGuard(dirty);
</script>

<template>
  <section class="settings-panel" aria-label="联网搜索设置">
    <h2>联网搜索</h2>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="notice"
      :title="notice"
      type="info"
      :closable="false"
      show-icon
    />
    <p v-if="busy" role="status">正在处理联网配置…</p>
    <el-button native-type="button" :disabled="busy" @click="load"
      >重新加载联网配置</el-button
    >
    <el-form
      label-position="top"
      :disabled="busy"
      v-if="loaded"
      @submit.prevent="save"
    >
      <p>启用后，助手可按问题需要搜索公开资料，并在回答中附来源链接。</p>
      <p v-if="dirty">联网配置有未保存的修改。</p>
      <fieldset :disabled="busy">
        <legend>搜索服务配置</legend>
        <label for="web-provider">搜索服务商</label>
        <el-select id="web-provider" v-model="provider"
          ><el-option value="tavily" label="Tavily"
        /></el-select>
        <el-form-item
          ><el-checkbox v-model="enabled" :disabled="clearKey"
            >启用联网搜索</el-checkbox
          ></el-form-item
        >
        <el-form-item
          ><template #label>搜索 API Key</template
          ><el-input
            aria-label="搜索 API Key"
            v-model="apiKey"
            type="password"
            autocomplete="off"
            maxlength="4096"
            :disabled="clearKey"
            :placeholder="
              saved?.hasApiKey ? '留空保留已保存密钥' : '请输入 Tavily API Key'
            "
        /></el-form-item>
        <p>密钥状态：{{ saved?.hasApiKey ? "已配置" : "未配置" }}</p>
        <el-form-item
          ><el-checkbox v-model="clearKey"
            >清除搜索密钥并关闭联网</el-checkbox
          ></el-form-item
        >
        <el-form-item
          ><el-checkbox v-model="allowFetch" :disabled="!enabled || clearKey"
            >允许读取网页正文</el-checkbox
          ></el-form-item
        >
        <el-form-item
          ><el-checkbox
            v-model="allowSchedules"
            :disabled="!enabled || clearKey"
            >允许定时任务联网</el-checkbox
          ></el-form-item
        >
        <p>
          搜索关键词和网页地址会发送给
          Tavily。仅支持公开网页；服务可能按调用量收费。
        </p>
        <p>
          保存配置会停止正在进行的联网请求；关闭权限或更换密钥后，运行任务的后续联网调用也会受限。
        </p>
        <el-button type="primary" :disabled="!dirty" native-type="submit"
          >保存联网配置</el-button
        >
      </fieldset>
      <el-button
        native-type="button"
        :disabled="busy || dirty || !saved?.hasApiKey"
        @click="test"
        >测试联网连接</el-button
      >
      <p>
        测试使用已保存的密钥查询一次“Tavily documentation”，可能消耗服务额度；每
        10 秒最多测试一次。
      </p>
    </el-form>
  </section>
</template>
