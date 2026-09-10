<script setup lang="ts">
import { confirmAction } from "../composables/confirm";
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ConversationContext } from "@mlclaw/shared";
import { api, ApiError } from "../api";
const props = defineProps<{ conversationId: string; active: boolean }>();
const emit = defineEmits<{ expired: []; started: [taskId: string] }>();
const state = ref<ConversationContext | null>(null);
const busy = ref(false);
const error = ref("");
const notice = ref("");
let alive = true;
let timer: ReturnType<typeof setInterval> | undefined;
let pending: { idempotencyKey: string; expectedVersion: number } | undefined;
const running = computed(
  () =>
    !!state.value?.latestTask &&
    ["queued", "running", "waiting_approval"].includes(
      state.value.latestTask.status,
    ),
);
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (cause) {
    if (!alive) return;
    if (cause instanceof ApiError && cause.status === 401) emit("expired");
    error.value = cause instanceof Error ? cause.message : "会话摘要操作失败";
  } finally {
    if (alive) busy.value = false;
  }
}
async function load() {
  const value = await api<ConversationContext>(
    `/conversations/${props.conversationId}/context`,
  );
  if (alive) state.value = value;
}
async function toggleValue(checked: string | number | boolean) {
  const enabled = Boolean(checked);
  await action(async () => {
    const result = await api<ConversationContext>(
      `/conversations/${props.conversationId}/context`,
      "PUT",
      { autoSummary: enabled, expectedVersion: state.value!.version },
    );
    if (alive) {
      state.value = result;
      notice.value = "自动摘要设置已保存，仅影响本会话的新任务";
    }
  });
}
async function generate(retry = false) {
  await action(async () => {
    if (retry || !pending)
      pending = {
        idempotencyKey: crypto.randomUUID(),
        expectedVersion: state.value!.version,
      };
    let result: { taskId: string };
    try {
      result = await api<{ taskId: string }>(
        `/conversations/${props.conversationId}/summary`,
        "POST",
        pending,
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409)
        pending = undefined;
      throw cause;
    }
    pending = undefined;
    if (!alive) return;
    emit("started", result.taskId);
    await load();
  });
}
async function clear() {
  if (!(await confirmAction("清除当前摘要，保留全部原始消息，是否继续？")))
    return;
  await action(async () => {
    const result = await api<ConversationContext>(
      `/conversations/${props.conversationId}/summary`,
      "DELETE",
      { expectedVersion: state.value!.version },
    );
    if (alive) {
      state.value = result;
      pending = undefined;
      notice.value = "摘要已清除，原始消息保留";
    }
  });
}
onMounted(() => {
  void action(load);
  timer = setInterval(() => {
    if (!busy.value && !error.value) void action(load);
  }, 3000);
});
onUnmounted(() => {
  alive = false;
  clearInterval(timer);
});
</script>
<template>
  <details aria-label="会话摘要">
    <summary>会话摘要与上下文</summary>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    /><el-alert
      v-if="notice"
      :title="notice"
      type="info"
      :closable="false"
      show-icon
    />
    <p v-if="busy">正在处理摘要状态…</p>
    <el-button :disabled="busy" @click="action(load)" native-type="submit"
      >刷新摘要状态</el-button
    >
    <template v-if="state">
      <el-form-item
        ><el-checkbox
          :model-value="state.autoSummary"
          :disabled="busy"
          @change="toggleValue"
          >本会话自动摘要</el-checkbox
        ></el-form-item
      >
      <p>
        开启后，在新任务上下文需要压缩时调用模型整理较早消息，可能增加模型费用。原始消息保留，摘要不会自动保存为长期记忆。
      </p>
      <p>
        已覆盖 {{ state.coveredMessages }} 条消息，尚有
        {{ state.remainingMessages }} 条原始消息未纳入摘要。
      </p>
      <p v-if="!state.summary">尚未生成会话摘要。</p>
      <p v-else-if="!state.valid" role="alert">
        摘要来源已改变，当前摘要已失效，不会注入新任务。
      </p>
      <p v-if="state.sourceTruncated">
        部分单条长消息在摘要输入中省略了中间内容，可查看原始消息核实。
      </p>
      <div v-if="state.summary">
        <pre class="summary-content">{{ state.summary }}</pre>
        <p>
          生成模型：{{ state.model ?? "未记录模型" }} · {{ state.updatedAt }}
        </p>
        <p>来源截止消息：{{ state.throughMessageId }}</p>
      </div>
      <p v-if="state.latestTask">
        最近摘要任务：{{ state.latestTask.status }}
        <span v-if="state.latestTask.error">{{ state.latestTask.error }}</span>
      </p>
      <el-button
        :disabled="busy || active || running || !state.remainingMessages"
        @click="generate()"
        native-type="submit"
        >{{ state.valid ? "继续生成摘要" : "生成会话摘要" }}</el-button
      >
      <el-button
        v-if="
          state.latestTask &&
          ['failed', 'cancelled', 'interrupted'].includes(
            state.latestTask.status,
          )
        "
        :disabled="busy || active || running || !state.remainingMessages"
        @click="generate(true)"
        native-type="submit"
        >重新生成摘要</el-button
      >
      <el-button
        v-if="running"
        :disabled="busy"
        @click="
          action(async () => {
            await api(`/tasks/${state!.latestTask!.id}/cancel`, 'POST');
            await load();
          })
        "
        native-type="submit"
        >取消摘要生成</el-button
      >
      <el-button
        :disabled="busy || !state.summary"
        @click="clear"
        native-type="submit"
        >清除会话摘要</el-button
      >
      <p>
        手动生成会占用当前任务名额，最多分 8
        批处理；剩余历史可继续生成。失败或取消不替换有效旧摘要。
      </p>
    </template>
  </details>
</template>
