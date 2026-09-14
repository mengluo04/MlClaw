import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  AssistantConfig,
  AssistantSettings,
  ModelSettings,
  SiteSettings,
} from '@mlclaw/shared';
import { api, ApiError } from '../api';

/** 共享登录状态的 Store 入口。 */
export const useSession = defineStore('session', () => {
  /** 已登录用户名；空字符串表示尚未登录。 */
  const user = ref('');
  const siteName = ref('MlClaw');
  const siteIconUrl = ref('/api/site-icon');
  const updateSite = (settings: SiteSettings) => {
    siteName.value = settings.name;
    document.title = settings.name;
  };
  const updateSiteIcon = (url: string) => {
    siteIconUrl.value = url;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = url;
  };
  /** 服务是否尚未完成管理员初始化。 */
  const setupRequired = ref(false);
  /** 是否已经加载服务状态。 */
  const statusLoaded = ref(false);
  /** 是否正在检查登录状态。 */
  const checking = ref(true);
  /** 当前错误提示。 */
  const error = ref('');
  /** 当前助手的展示名称。 */
  const assistantLabel = ref('助手');
  /** 所有对话位置共享的头像地址，更新后触发图片重新加载。 */
  const assistantAvatarUrl = ref('/api/assistant-avatar');
  /** 助手是否已完成首次身份设置。 */
  const assistantConfigured = ref(false);
  /** 当前默认模型的页面展示名称。 */
  const modelLabel = ref('尚未指定');
  /** 当前用户已保存的模型配置。 */
  const modelSettings = ref<ModelSettings>({ providers: [], defaultModel: null });
  /** 将助手配置同步到前端会话状态。 */
  const updateAssistant = (config: AssistantConfig) => {
    assistantLabel.value = config.name.trim() || '助手';
    assistantConfigured.value = config.onboardingCompleted;
  };
  /** 刷新助手及默认模型配置。 */
  const refreshConfig = async () => {
    /** assistant：当前助手配置；models：当前可用模型列表。 */
    const [assistant, models] = await Promise.all([
      api<AssistantSettings>('/settings/assistant'),
      api<ModelSettings>('/settings/models'),
    ]);
    updateAssistant(assistant.config);
    modelSettings.value = models;
    /** 当前模型或联网服务提供商。 */
    const provider = models.providers.find((item) => item.id === models.defaultModel?.providerId);
    modelLabel.value =
      provider && models.defaultModel
        ? `${provider.name} / ${models.defaultModel.model}`
        : '尚未指定';
  };
  /** 清空当前记录或交互状态。 */
  const clear = () => {
    user.value = '';
    assistantLabel.value = '助手';
    assistantAvatarUrl.value = `/api/assistant-avatar?refresh=${Date.now()}`;
    assistantConfigured.value = false;
    modelLabel.value = '尚未指定';
    modelSettings.value = { providers: [], defaultModel: null };
  };
  /** 检查当前状态是否满足后续操作条件。 */
  const check = async () => {
    checking.value = true;
    error.value = '';
    try {
      updateSite(await api<SiteSettings>('/site'));
      setupRequired.value = (await api<{ setupRequired: boolean }>('/auth/status')).setupRequired;
      statusLoaded.value = true;
      if (setupRequired.value) {
        clear();
        return;
      }
      user.value = (await api<{ username: string }>('/auth/me')).username;
      await refreshConfig();
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
      if (cause instanceof ApiError && cause.status === 401) clear();
      else error.value = '无法连接服务，请重试';
    } finally {
      checking.value = false;
    }
  };
  return {
    siteName,
    siteIconUrl,
    updateSite,
    updateSiteIcon,
    user,
    setupRequired,
    statusLoaded,
    checking,
    error,
    assistantLabel,
    assistantAvatarUrl,
    assistantConfigured,
    modelLabel,
    modelSettings,
    updateAssistant,
    clear,
    check,
    refreshConfig,
  };
});
