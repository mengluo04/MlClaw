<script setup lang="ts">
import { ref, watch } from 'vue';
import type { AssistantConfig, AssistantTemplate } from '@mlclaw/shared';
import { api, ApiError } from '../api';
/** 父组件传入的属性。 */
const props = defineProps<{ config: AssistantConfig; disabled: boolean }>();
/** 向父组件发送事件的方法。 */
const emit = defineEmits<{ apply: [config: AssistantConfig]; expired: [] }>();
/** 操作进行中标记，用于禁用重复提交。 */
const busy = ref(false);
/** 当前错误提示。 */
const error = ref('');
/** 本次处理结果。 */
const result = ref<{
  config: AssistantConfig;
  changes: { field: string; before: string; after: string }[];
  warnings: string[];
} | null>(null);
/** 可应用到助手草稿的内置模板列表。 */
const templates = ref<AssistantTemplate[]>([]);
/** 当前选中项。 */
const selected = ref('');
watch(
  () => props.config,
  () => {
    result.value = null;
  },
  { deep: true },
);
/** 统一执行页面操作并处理错误与忙碌状态。 */
const perform = async (fn: () => Promise<void>) => {
  if (busy.value || props.disabled) return;
  busy.value = true;
  error.value = '';
  try {
    await fn();
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
    if (cause instanceof ApiError && cause.status === 401) emit('expired');
    error.value = cause instanceof Error ? cause.message : '操作失败';
  } finally {
    busy.value = false;
  }
};
/** 获取可用助手模板列表。 */
const loadTemplates = async () => {
  await perform(async () => {
    templates.value = await api<AssistantTemplate[]>('/settings/assistant/templates');
  });
};
/** 计算模板与当前助手配置的差异。 */
const previewTemplate = () => {
  /** 当前选中的助手模板。 */
  const template = templates.value.find((item) => item.id === selected.value);
  if (!template) return;
  /** 准备合并到编辑草稿的模板配置。 */
  const templateConfig = JSON.parse(JSON.stringify(template.config)) as AssistantConfig;
  /** 当前流程使用的配置。 */
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
      '模板仅替换角色、性格、规则和工具约定，保留身份名称和用户资料。应用到草稿后仍需保存。',
    ],
    changes: (Object.keys(config) as (keyof AssistantConfig)[])
      .filter((key) => JSON.stringify(config[key]) !== JSON.stringify(props.config[key]))
      .map((field) => ({
        field,
        before: JSON.stringify(props.config[field]),
        after: JSON.stringify(config[field]),
      })),
  };
};
</script>
<template>
  <details>
    <summary>助手模板</summary>
    <p>选择工作风格模板，预览差异后应用到草稿，再保存生效。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <fieldset :disabled="busy || disabled">
      <el-button native-type="button" @click="loadTemplates">加载助手模板</el-button>
      <template v-if="templates.length"
        ><label for="assistant-template">助手模板</label
        ><el-select id="assistant-template" v-model="selected"
          ><el-option value="" label="选择模板" /><el-option
            v-for="item in templates"
            :key="item.id"
            :value="item.id"
            :label="`${item.name} · ${item.description}`" /></el-select
        ><el-button native-type="button" :disabled="!selected" @click="previewTemplate"
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
