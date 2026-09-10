<script setup lang="ts">
import { confirmAction } from "../composables/confirm";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { AssistantPreview, ConversationRules } from "@mlclaw/shared";
import { api, ApiError } from "../api";
const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ expired: []; dirty: [value: boolean] }>();
const saved = ref<ConversationRules | null>(null);
const content = ref("");
const busy = ref(false);
const notice = ref("");
const error = ref("");
const preview = ref<AssistantPreview | null>(null);
const dirty = computed(
  () => saved.value !== null && content.value !== saved.value.content,
);
watch(dirty, (value) => emit("dirty", value));
watch(content, () => {
  preview.value = null;
});
async function perform(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) emit("expired");
    error.value = cause instanceof Error ? cause.message : "会话规则操作失败";
  } finally {
    busy.value = false;
  }
}
async function load() {
  await perform(async () => {
    saved.value = await api<ConversationRules>(
      `/conversations/${props.conversationId}/rules`,
    );
    content.value = saved.value.content;
  });
}
async function reload() {
  if (
    dirty.value &&
    !(await confirmAction("重新加载将丢弃未保存的会话规则，是否继续？"))
  )
    return;
  await load();
}
async function save() {
  if (saved.value)
    await perform(async () => {
      saved.value = await api<ConversationRules>(
        `/conversations/${props.conversationId}/rules`,
        "PUT",
        { content: content.value, expectedVersion: saved.value!.version },
      );
      content.value = saved.value.content;
      notice.value = "会话规则已保存，仅影响此对话的新任务";
    });
}
async function showPreview() {
  await perform(async () => {
    preview.value = await api<AssistantPreview>(
      `/conversations/${props.conversationId}/rules/preview`,
      "POST",
      { content: content.value },
    );
  });
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onMounted(() => {
  void load();
  window.addEventListener("beforeunload", beforeUnload);
});
onUnmounted(() => window.removeEventListener("beforeunload", beforeUnload));
</script>
<template>
  <details>
    <summary>会话补充规则</summary>
    <p>
      仅用于此对话的新任务，最多 4000
      字符。表达偏好以本次明确要求、会话规则、全局默认为序；工具权限始终由服务端控制。清空并保存可停用。
    </p>
    <p v-if="busy" role="status">正在处理会话规则…</p>
    <p v-if="error" role="alert">
      {{ error }}
      <el-button :disabled="busy" @click="reload" native-type="submit"
        >重新加载会话规则</el-button
      >
    </p>
    <el-alert
      v-if="notice"
      :title="notice"
      type="info"
      :closable="false"
      show-icon
    />
    <template v-if="saved">
      <p>
        会话规则版本：{{ saved.version }} <span v-if="dirty">· 尚未保存</span>
      </p>
      <el-form label-position="top" :disabled="busy" @submit.prevent="save"
        ><el-form-item
          ><template #label>此对话的补充规则</template
          ><el-input
            aria-label="此对话的补充规则"
            type="textarea"
            v-model="content"
            :disabled="busy"
            :rows="4"
            maxlength="4000" /></el-form-item
        ><el-button
          type="primary"
          :disabled="busy || !dirty"
          native-type="submit"
          >保存会话规则</el-button
        ><el-button native-type="button" :disabled="busy" @click="showPreview"
          >预览会话规则</el-button
        ><el-button native-type="button" :disabled="busy" @click="reload"
          >重新加载会话规则</el-button
        ></el-form
      >
      <div v-if="preview">
        <p>
          预览不保存、不调用模型，不包含历史消息。总占用
          {{ preview.budget.used }} 字符，非精确 token。
        </p>
        <details v-for="part in preview.sections" :key="part.source">
          <summary>{{ part.source }}</summary>
          <pre>{{ part.content }}</pre>
        </details>
      </div>
    </template>
  </details>
</template>
