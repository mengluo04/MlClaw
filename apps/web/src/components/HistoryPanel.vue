<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { Task, TaskSearch } from "@mlclaw/shared";
import { modelLabel } from "../composables/taskLabels";
import { api } from "../api";
import { useOperation } from "../composables/operation";
import { useChat, statusLabel } from "../stores/chat";
const { busy, error, run } = useOperation();
const chat = useChat();
type Row = {
  id: string;
  status: string;
  input: string;
  created_at?: string;
  createdAt?: string;
  conversation_id?: string;
  conversationId?: string;
};
const items = ref<Row[]>([]);
const nextCursor = ref<string | null>(null);
const query = ref("");
const scope = ref("all");
const status = ref("");
const searched = ref(false);
const truncated = ref(false);
const loaded = ref(false);
const detail = ref<Task | null>(null);
const detailOpen = ref(false);
async function load(older = false) {
  if (scope.value === "current" && !chat.selected)
    throw new Error("请先打开一个会话，或选择全部会话");
  const params = new URLSearchParams();
  if (scope.value === "current") params.set("conversationId", chat.selected);
  if (query.value.trim()) {
    params.set("scope", scope.value);
    params.set("q", query.value.trim());
    const result = await api<TaskSearch>(`/tasks/search?${params}`);
    items.value = result.items;
    nextCursor.value = null;
    searched.value = true;
    truncated.value = result.truncated;
  } else {
    if (status.value) params.set("status", status.value);
    if (older && nextCursor.value) params.set("before", nextCursor.value);
    const result = await api<{ items: Row[]; nextCursor: string | null }>(
      `/tasks/page?${params}`,
    );
    items.value = older ? [...items.value, ...result.items] : result.items;
    nextCursor.value = result.nextCursor;
    searched.value = false;
  }
  loaded.value = true;
}
async function inspect(id: string) {
  await run(async () => {
    detail.value = await api<Task>(`/tasks/${id}`);
    detailOpen.value = true;
  });
}
function usage(value: string | null) {
  if (!value) return "服务未返回用量";
  try {
    const data = JSON.parse(value);
    return `输入 ${data.prompt_tokens ?? "未知"} / 输出 ${data.completion_tokens ?? "未知"} / 合计 ${data.total_tokens ?? "未知"} tokens`;
  } catch {
    return "用量数据不可用";
  }
}
function duration(task: Task) {
  return task.finished_at
    ? `${Math.max(0, Date.parse(task.finished_at.replace(" ", "T") + "Z") - Date.parse(task.created_at.replace(" ", "T") + "Z")) / 1000} 秒`
    : "尚未结束";
}
onMounted(() => void run(() => load()));
</script>
<template>
  <section>
    <h2>运行记录</h2>
    <p>查看任务结果、实际模型和工具执行过程。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false"
      ><el-button text @click="run(() => load())">重试</el-button></el-alert
    >
    <el-form class="history-filters" @submit.prevent="run(() => load())"
      ><el-input
        v-model="query"
        aria-label="历史任务关键词"
        placeholder="搜索已结束任务的输入和工具结果"
        maxlength="200"
        clearable
      /><el-select v-model="scope" aria-label="历史检索范围"
        ><el-option value="all" label="我的全部会话" /><el-option
          value="current"
          label="当前会话"
          :disabled="!chat.selected" /></el-select
      ><el-select
        v-model="status"
        aria-label="任务状态筛选"
        placeholder="所有状态"
        :disabled="!!query.trim()"
        ><el-option value="" label="所有状态" /><el-option
          v-for="value in [
            'succeeded',
            'running',
            'waiting_approval',
            'failed',
            'cancelled',
            'interrupted',
          ]"
          :key="value"
          :value="value"
          :label="statusLabel(value)" /></el-select
      ><el-button native-type="submit" :loading="busy">查询</el-button></el-form
    >
    <p v-if="searched">
      关键词搜索仅包含已结束任务，最多 10 条。{{
        truncated ? "结果已截断，请细化关键词。" : ""
      }}
    </p>
    <el-skeleton v-if="busy && !loaded" :rows="5" animated /><el-table
      v-else
      class="desktop-data"
      :data="items"
      empty-text="暂无符合条件的记录"
      ><el-table-column
        prop="input"
        label="任务"
        min-width="240"
        show-overflow-tooltip
      /><el-table-column label="状态" width="130"
        ><template #default="{ row }"
          ><el-tag :type="row.status === 'failed' ? 'danger' : 'info'">{{
            statusLabel(String(row.status))
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="创建时间" width="180"
        ><template #default="{ row }">{{
          row.created_at ?? row.createdAt
        }}</template></el-table-column
      ><el-table-column label="操作" width="160"
        ><template #default="{ row }"
          ><el-button text :disabled="busy" @click="inspect(String(row.id))"
            >详情</el-button
          ><RouterLink
            :to="`/chat/${row.conversation_id ?? row.conversationId}`"
            >会话</RouterLink
          ></template
        ></el-table-column
      ></el-table
    >
    <div class="mobile-data">
      <el-empty
        v-if="loaded && !items.length"
        description="暂无符合条件的记录"
      />
      <el-card v-for="row in items" :key="row.id" shadow="never">
        <h3>{{ row.input }}</h3>
        <el-tag>{{ statusLabel(row.status) }}</el-tag>
        <p>{{ row.created_at ?? row.createdAt }}</p>
        <el-button :disabled="busy" @click="inspect(row.id)">详情</el-button>
        <RouterLink :to="`/chat/${row.conversation_id ?? row.conversationId}`"
          >打开会话</RouterLink
        >
      </el-card>
    </div>
    <el-button v-if="nextCursor" :loading="busy" @click="run(() => load(true))"
      >加载更早记录</el-button
    >
    <el-drawer
      v-model="detailOpen"
      title="任务详情"
      size="620px"
      destroy-on-close
      ><div v-if="detail" class="feature-panel">
        <el-tag>{{ statusLabel(detail.status) }}</el-tag>
        <h3>{{ detail.input }}</h3>
        <p>{{ detail.created_at }} · 耗时 {{ duration(detail) }}</p>
        <p>{{ usage(detail.usage) }}</p>
        <p v-if="detail.model_snapshot">
          实际模型：{{ modelLabel(detail.model_snapshot) }}
        </p>
        <el-alert
          v-if="detail.error"
          :title="detail.error"
          type="error"
          :closable="false"
        /><el-empty
          v-if="!detail.tools?.length"
          description="此任务没有工具调用"
        /><el-collapse
          ><el-collapse-item
            v-for="tool in detail.tools"
            :key="tool.id"
            :name="tool.id"
            :title="`${tool.name} · ${statusLabel(tool.status)}`"
            ><h4>调用参数</h4>
            <pre>{{ tool.arguments }}</pre>
            <h4>执行结果</h4>
            <pre>{{ tool.result ?? "暂无结果" }}</pre>
          </el-collapse-item></el-collapse
        >
        <p v-for="(skill, index) in detail.skills" :key="index">
          已加载 {{ skill.name }} · 版本 {{ skill.version }}
        </p>
      </div></el-drawer
    >
  </section>
</template>
