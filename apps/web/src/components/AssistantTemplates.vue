<script setup lang="ts">
import { ref, watch } from "vue";
import type { AssistantConfig, AssistantTemplate } from "@mlclaw/shared";
import { api, ApiError } from "../api";
const props = defineProps<{ config: AssistantConfig; disabled: boolean }>();
const emit = defineEmits<{ apply: [config: AssistantConfig]; expired: [] }>();
const busy = ref(false);
const error = ref("");
const result = ref<{
  config: AssistantConfig;
  changes: { field: string; before: string; after: string }[];
  warnings: string[];
} | null>(null);
const templates = ref<AssistantTemplate[]>([]);
const selected = ref("");
watch(
  () => props.config,
  () => {
    result.value = null;
  },
  { deep: true },
);
async function perform(fn: () => Promise<void>) {
  if (busy.value || props.disabled) return;
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) emit("expired");
    error.value = cause instanceof Error ? cause.message : "操作失败";
  } finally {
    busy.value = false;
  }
}
async function loadTemplates() {
  await perform(async () => {
    templates.value = await api<AssistantTemplate[]>(
      "/settings/assistant/templates",
    );
  });
}
function previewTemplate() {
  const template = templates.value.find((item) => item.id === selected.value);
  if (!template) return;
  const templateConfig = JSON.parse(
    JSON.stringify(template.config),
  ) as AssistantConfig;
  const config = {
    ...templateConfig,
    name: props.config.name,
    emoji: props.config.emoji,
    userName: props.config.userName,
    language: props.config.language,
    timezone: props.config.timezone,
    userBackground: props.config.userBackground,
    onboardingCompleted: props.config.onboardingCompleted,
  };
  result.value = {
    config,
    warnings: [
      "模板仅替换角色、性格、规则和工具约定，保留身份名称和用户资料。应用到草稿后仍需保存。",
    ],
    changes: (Object.keys(config) as (keyof AssistantConfig)[])
      .filter(
        (key) =>
          JSON.stringify(config[key]) !== JSON.stringify(props.config[key]),
      )
      .map((field) => ({
        field,
        before: JSON.stringify(props.config[field]),
        after: JSON.stringify(config[field]),
      })),
  };
}
</script>
<template>
  <details>
    <summary>助手模板</summary>
    <p>选择工作风格模板，预览差异后应用到草稿，再保存生效。</p>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <fieldset :disabled="busy || disabled">
      <el-button native-type="button" @click="loadTemplates"
        >加载助手模板</el-button
      >
      <template v-if="templates.length"
        ><label for="assistant-template">助手模板</label
        ><el-select id="assistant-template" v-model="selected"
          ><el-option value="" label="选择模板" /><el-option
            v-for="item in templates"
            :key="item.id"
            :value="item.id"
            :label="`${item.name} · ${item.description}`" /></el-select
        ><el-button
          native-type="button"
          :disabled="!selected"
          @click="previewTemplate"
          >预览模板差异</el-button
        ></template
      >
      <div v-if="result" aria-label="配置差异">
        <p v-for="warning in result.warnings" :key="warning">{{ warning }}</p>
        <p v-if="!result.changes.length">没有配置变化。</p>
        <details v-for="change in result.changes" :key="change.field">
          <summary>{{ change.field }}</summary>
          <p>原内容</p>
          <pre>{{ change.before }}</pre>
          <p>新内容</p>
          <pre>{{ change.after }}</pre>
        </details>
        <el-button
          native-type="button"
          :disabled="!result.changes.length"
          @click="emit('apply', result.config)"
          >应用到草稿</el-button
        >
      </div>
    </fieldset>
  </details>
</template>
