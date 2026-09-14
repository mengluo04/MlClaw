<script setup lang="ts">
import { confirmAction } from '../composables/confirm';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ConversationContext } from '@mlclaw/shared';
import { api, ApiError } from '../api';
import { createUuid } from '../uuid';
/** 父组件传入的属性。 */
const props = defineProps<{ conversationId: string; active: boolean }>();
/** 向父组件发送事件的方法。 */
const emit = defineEmits<{ expired: []; started: [taskId: string] }>();
/** 当前运行状态。 */
const state = ref<ConversationContext | null>(null);
/** 操作进行中标记，用于禁用重复提交。 */
const busy = ref(false);
/** 当前错误提示。 */
const error = ref('');
/** 当前操作反馈文案。 */
const notice = ref('');
/** 组件是否仍挂载，防止卸载后的异步回调更新状态。 */
let alive = true;
/** 延迟执行或超时控制的定时器句柄。 */
let timer: ReturnType<typeof setInterval> | undefined;
/** 等待后续处理的数据。 */
let pending: { idempotencyKey: string; expectedVersion: number } | undefined;
/** 正在运行的任务及取消控制器。 */
const running = computed(
  () =>
    !!state.value?.latestTask &&
    ['queued', 'running', 'waiting_approval'].includes(state.value.latestTask.status),
);
/** 统一处理操作期间的忙碌状态与错误反馈。 */
const action = async (fn: () => Promise<void>) => {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
    if (!alive) return;
    if (cause instanceof ApiError && cause.status === 401) emit('expired');
    error.value = cause instanceof Error ? cause.message : '会话摘要操作失败';
  } finally {
    if (alive) busy.value = false;
  }
};
/** 加载当前页面或业务所需的数据。 */
const load = async () => {
  /** 接口 /conversations/${props.conversationId}/context 返回的业务数据。 */
  const value = await api<ConversationContext>(`/conversations/${props.conversationId}/context`);
  if (alive) state.value = value;
};
/** 保存会话自动摘要开关。 */
const toggleValue = async (checked: string | number | boolean) => {
  /** 当前功能是否启用。 */
  const enabled = Boolean(checked);
  await action(async () => {
    /** 接口 /conversations/${props.conversationId}/context 返回的业务数据。 */
    const result = await api<ConversationContext>(
      `/conversations/${props.conversationId}/context`,
      'PUT',
      { autoSummary: enabled, expectedVersion: state.value!.version },
    );
    if (alive) {
      state.value = result;
      notice.value = '自动压缩设置已保存；关闭后运行中的任务也不再开始新的压缩';
    }
  });
};
/** 请求生成会话摘要并跟踪任务状态。 */
const generate = async (retry = false) => {
  await action(async () => {
    if (retry || !pending)
      pending = {
        idempotencyKey: createUuid(),
        expectedVersion: state.value!.version,
      };
    /** 本次处理结果。 */
    let result: { taskId: string };
    try {
      result = await api<{ taskId: string }>(
        `/conversations/${props.conversationId}/summary`,
        'POST',
        pending,
      );
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
      if (cause instanceof ApiError && cause.status === 409) pending = undefined;
      throw cause;
    }
    pending = undefined;
    if (!alive) return;
    emit('started', result.taskId);
    await load();
  });
};
/** 清空当前记录或交互状态。 */
const clear = async () => {
  if (!(await confirmAction('清除当前摘要，保留全部原始消息，是否继续？'))) return;
  await action(async () => {
    /** 接口 /conversations/${props.conversationId}/summary 返回的业务数据。 */
    const result = await api<ConversationContext>(
      `/conversations/${props.conversationId}/summary`,
      'DELETE',
      { expectedVersion: state.value!.version },
    );
    if (alive) {
      state.value = result;
      pending = undefined;
      notice.value = '摘要已清除，原始消息保留';
    }
  });
};
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
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon /><el-alert
      v-if="notice"
      :title="notice"
      type="info"
      :closable="false"
      show-icon
    />
    <p v-if="busy">正在处理摘要状态…</p>
    <el-button :disabled="busy" @click="action(load)" native-type="submit">刷新摘要状态</el-button>
    <template v-if="state">
      <el-form-item
        ><el-checkbox :model-value="state.autoSummary" :disabled="busy" @change="toggleValue"
          >上下文超限时自动压缩</el-checkbox
        ></el-form-item
      >
      <p>
        开启后，仅在模型服务明确提示上下文超限时整理较早消息和已完成的工具记录，再重试当前模型请求。原始记录保留，不重复执行已完成的工具；压缩可能增加模型费用。
      </p>
      <p>
        已覆盖 {{ state.coveredMessages }} 条消息，尚有
        {{ state.remainingMessages }} 条原始消息未纳入摘要。
      </p>
      <p v-if="!state.summary">尚未生成会话摘要。</p>
      <p v-else-if="!state.valid" role="alert">摘要来源已改变，当前摘要已失效，不会注入新任务。</p>
      <p v-if="state.sourceTruncated">
        摘要输入曾省略部分历史内容，可查看原始消息和工具记录核实。
      </p>
      <div v-if="state.summary">
        <pre class="summary-content">{{ state.summary }}</pre>
        <p>生成模型：{{ state.model ?? '未记录模型' }} · {{ state.updatedAt }}</p>
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
        >{{ state.valid ? '继续生成摘要' : '生成会话摘要' }}</el-button
      >
      <el-button
        v-if="
          state.latestTask &&
          ['failed', 'cancelled', 'interrupted'].includes(state.latestTask.status)
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
      <el-button :disabled="busy || !state.summary" @click="clear" native-type="submit"
        >清除会话摘要</el-button
      >
      <p>
        手动生成会占用当前任务名额，最多分 8
        批处理；剩余历史可继续生成。失败或取消不替换有效旧摘要。
      </p>
    </template>
  </details>
</template>
