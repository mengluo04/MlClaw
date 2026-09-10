import { defineStore } from "pinia";
import { ref } from "vue";
import type { AssistantSettings, ModelSettings } from "@mlclaw/shared";
import { api, ApiError } from "../api";

export const useSession = defineStore("session", () => {
  const user = ref("");
  const checking = ref(true);
  const error = ref("");
  const assistantLabel = ref("助手");
  const modelLabel = ref("尚未指定");
  async function refreshConfig() {
    const [assistant, models] = await Promise.all([
      api<AssistantSettings>("/settings/assistant"),
      api<ModelSettings>("/settings/models"),
    ]);
    assistantLabel.value =
      `${assistant.config.emoji} ${assistant.config.name}`.trim();
    const provider = models.providers.find(
      (item) => item.id === models.defaultModel?.providerId,
    );
    modelLabel.value =
      provider && models.defaultModel
        ? `${provider.name} / ${models.defaultModel.model}`
        : "尚未指定";
  }
  function clear() {
    user.value = "";
    assistantLabel.value = "助手";
    modelLabel.value = "尚未指定";
  }
  async function check() {
    checking.value = true;
    error.value = "";
    try {
      user.value = (await api<{ username: string }>("/auth/me")).username;
      await refreshConfig();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) clear();
      else error.value = "无法连接服务，请重试";
    } finally {
      checking.value = false;
    }
  }
  return {
    user,
    checking,
    error,
    assistantLabel,
    modelLabel,
    clear,
    check,
    refreshConfig,
  };
});
