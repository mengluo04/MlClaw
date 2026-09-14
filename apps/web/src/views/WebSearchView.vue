<script setup lang="ts">
import { useSession } from '../stores/session';
import { useDirtyGuard } from '../composables/dirty';
import { confirmAction } from '../composables/confirm';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { WebSettings, WebConnectionTest } from '@mlclaw/shared';
import { api, ApiError } from '../api';

/** 当前用户的登录与助手状态。 */
const session = useSession();
/** 是否已完成首次数据加载。 */
const loaded = ref(false);
/** 操作进行中标记，用于禁用重复提交。 */
const busy = ref(false);
/** 当前错误提示。 */
const error = ref('');
/** 当前操作反馈文案。 */
const notice = ref('');
/** 已保存的记录或响应。 */
const saved = ref<WebSettings | null>(null);
/** 当前模型或联网服务提供商。 */
const provider = ref<WebSettings['provider']>('tavily');
/** 当前功能是否启用。 */
const enabled = ref(false);
/** 是否允许读取网页正文。 */
const allowFetch = ref(true);
/** 是否允许定时任务联网。 */
const allowSchedules = ref(false);
/** 仅在当前调用或编辑流程中使用的服务密钥。 */
const apiKey = ref('');
/** 服务基础地址。 */
const baseUrl = ref('');
/** 保存时是否清除已有服务密钥。 */
const clearKey = ref(false);
/** 编辑开始时的序列化基线，用于检测未保存修改。 */
const original = ref('');
/** 可用模型提供商列表。 */
const providers: Array<{ value: WebSettings['provider']; label: string }> = [
  { value: 'tavily', label: 'Tavily' },
  { value: 'firecrawl', label: 'Firecrawl' },
  { value: 'exa', label: 'Exa' },
  { value: 'brave', label: 'Brave Search' },
  { value: 'searxng', label: 'SearXNG' },
];
/** 业务值到展示标签的映射。 */
const labels = Object.fromEntries(providers.map((item) => [item.value, item.label]));
/** 所选联网服务是否需要密钥。 */
const needsApiKey = computed(() => provider.value !== 'searxng');
/** 所选联网服务是否支持正文读取。 */
const supportsFetch = computed(() => ['tavily', 'firecrawl', 'exa'].includes(provider.value));
/** 是否正在清除当前服务密钥。 */
const clearingKey = computed(() => needsApiKey.value && clearKey.value);
/** 当前配置是否已保存密钥。 */
const hasCurrentKey = computed(
  () => saved.value?.provider === provider.value && saved.value.hasApiKey,
);
/** 当前配置是否满足连接测试条件。 */
const canTest = computed(() =>
  provider.value === 'searxng' ? !!saved.value?.baseUrl : !!saved.value?.hasApiKey,
);
/** 读取或构造当前编辑草稿。 */
const draft = () =>
  JSON.stringify([
    provider.value,
    enabled.value,
    supportsFetch.value && allowFetch.value,
    allowSchedules.value,
    provider.value === 'searxng' ? baseUrl.value : '',
  ]);
/** 当前草稿是否偏离已保存内容。 */
const dirty = computed(
  () => loaded.value && (draft() !== original.value || !!apiKey.value || clearingKey.value),
);
// 草稿保留在页面内；刷新或退出登录时提示。
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = '';
  }
};
/** 将服务端记录填入编辑草稿并更新保存基线。 */
const apply = (value: WebSettings) => {
  saved.value = value;
  provider.value = value.provider;
  enabled.value = value.enabled;
  allowFetch.value = value.allowFetch;
  allowSchedules.value = value.allowSchedules;
  baseUrl.value = value.baseUrl;
  apiKey.value = '';
  clearKey.value = false;
  original.value = draft();
  loaded.value = true;
};
/** 统一处理操作期间的忙碌状态与错误反馈。 */
const action = async (fn: () => Promise<void>) => {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
    if (cause instanceof ApiError && cause.status === 401) session.clear();
    error.value = cause instanceof Error ? cause.message : '操作失败，请重试';
  } finally {
    busy.value = false;
  }
};
/** 加载当前页面或业务所需的数据。 */
const load = async () => {
  if (dirty.value && !(await confirmAction('重新加载将丢弃未保存的联网配置，是否继续？'))) return;
  await action(async () => apply(await api<WebSettings>('/settings/web')));
};
/** 切换联网服务并重置不再适用的配置。 */
const changeProvider = () => {
  apiKey.value = '';
  clearKey.value = false;
  baseUrl.value = saved.value?.provider === provider.value ? saved.value.baseUrl : '';
  allowFetch.value = supportsFetch.value;
};
/** 校验并保存当前编辑内容。 */
const save = async () => {
  await action(async () => {
    apply(
      await api<WebSettings>('/settings/web', 'PUT', {
        provider: provider.value,
        enabled: enabled.value,
        allowFetch: allowFetch.value,
        allowSchedules: allowSchedules.value,
        ...(provider.value === 'searxng' ? { baseUrl: baseUrl.value } : {}),
        expectedVersion: saved.value!.version,
        ...(clearingKey.value ? { apiKey: '' } : apiKey.value ? { apiKey: apiKey.value } : {}),
      }),
    );
    notice.value = '联网配置已保存，无需重启；新任务使用新配置。';
  });
};
/** 执行当前配置的连接验证并显示结果。 */
const test = async () => {
  await action(async () => {
    /** 接口 /settings/web/test 返回的业务数据。 */
    const result = await api<WebConnectionTest>('/settings/web/test', 'POST', {
      expectedVersion: saved.value!.version,
    });
    notice.value = `联网连接成功，用时 ${result.durationMs} 毫秒，返回 ${result.resultCount} 条结果。`;
  });
};
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload);
  void load();
});
onUnmounted(() => {
  window.removeEventListener('beforeunload', beforeUnload);
});

useDirtyGuard(dirty);
</script>

<template>
  <div class="page-content feature-panel">
    <section class="settings-panel" aria-label="联网搜索设置">
      <h2>联网搜索</h2>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-alert v-if="notice" :title="notice" type="info" :closable="false" show-icon />
      <p v-if="busy" role="status">正在处理联网配置…</p>
      <el-button native-type="button" :disabled="busy" @click="load">重新加载联网配置</el-button>
      <el-form label-position="top" :disabled="busy" v-if="loaded" @submit.prevent="save">
        <p>启用后，助手可按问题需要搜索公开资料，并在回答中附来源链接。</p>
        <p v-if="dirty">联网配置有未保存的修改。</p>
        <fieldset :disabled="busy">
          <legend>搜索服务配置</legend>
          <label for="web-provider">搜索服务商</label>
          <el-select id="web-provider" v-model="provider" @change="changeProvider"
            ><el-option
              v-for="item in providers"
              :key="item.value"
              :value="item.value"
              :label="item.label"
          /></el-select>
          <el-form-item
            ><el-checkbox v-model="enabled" :disabled="clearingKey"
              >启用联网搜索</el-checkbox
            ></el-form-item
          >
          <el-form-item v-if="needsApiKey"
            ><template #label>搜索 API Key</template
            ><el-input
              aria-label="搜索 API Key"
              v-model="apiKey"
              type="password"
              autocomplete="off"
              maxlength="4096"
              :disabled="clearingKey"
              :placeholder="
                hasCurrentKey ? '留空保留已保存密钥' : `请输入 ${labels[provider]} API Key`
              "
          /></el-form-item>
          <p v-if="needsApiKey">密钥状态：{{ hasCurrentKey ? '已配置' : '未配置' }}</p>
          <el-form-item v-if="needsApiKey"
            ><el-checkbox v-model="clearKey">清除搜索密钥并关闭联网</el-checkbox></el-form-item
          >
          <el-form-item v-else
            ><template #label>SearXNG 实例地址</template
            ><el-input
              aria-label="SearXNG 实例地址"
              v-model="baseUrl"
              maxlength="2048"
              placeholder="例如 http://127.0.0.1:8888"
          /></el-form-item>
          <el-form-item
            ><el-checkbox v-model="allowFetch" :disabled="!enabled || clearingKey || !supportsFetch"
              >允许读取网页正文</el-checkbox
            ></el-form-item
          >
          <p v-if="!supportsFetch">当前服务仅提供搜索结果，不支持读取任意网页正文。</p>
          <el-form-item
            ><el-checkbox v-model="allowSchedules" :disabled="!enabled || clearingKey"
              >允许定时任务联网</el-checkbox
            ></el-form-item
          >
          <p>搜索关键词会发送给 {{ labels[provider] }}；服务额度和数据处理规则以提供商为准。</p>
          <p v-if="supportsFetch">
            读取链接时先直接访问目标网站，脚本和文本只读取、不执行；需要备用正文提取时才将网址发送给所选服务。
          </p>
          <p>
            保存配置会停止正在进行的联网请求；关闭权限或更换密钥后，运行任务的后续联网调用也会受限。
          </p>
          <el-button type="primary" :disabled="!dirty" native-type="submit">保存联网配置</el-button>
        </fieldset>
        <el-button native-type="button" :disabled="busy || dirty || !canTest" @click="test"
          >测试联网连接</el-button
        >
        <p>
          测试使用已保存配置查询一次“MlClaw web search connection test”，可能消耗服务额度；每 10
          秒最多测试一次。
        </p>
      </el-form>
    </section>
  </div>
</template>
