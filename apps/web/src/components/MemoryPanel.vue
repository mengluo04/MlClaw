<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { Memory, MemorySearch } from "@mlclaw/shared";
import { api } from "../api";
import { useOperation } from "../composables/operation";
import { useDirtyGuard } from "../composables/dirty";
import { confirmAction } from "../composables/confirm";
const { busy, error, notice, run } = useOperation();
const items = ref<Memory[]>([]);
const query = ref("");
const result = ref<MemorySearch | null>(null);
const loaded = ref(false);
const editorOpen = ref(false);
const editing = ref("");
const content = ref("");
const priority = ref(0);
const baseline = ref("");
const dirty = computed(
  () =>
    editorOpen.value &&
    JSON.stringify([content.value, priority.value]) !== baseline.value,
);
useDirtyGuard(dirty);
const visible = computed(() =>
  result.value ? result.value.items : items.value,
);
async function load() {
  items.value = await api<Memory[]>("/memories");
  loaded.value = true;
  if (query.value.trim())
    result.value = await api<MemorySearch>(
      `/memories/search?q=${encodeURIComponent(query.value)}`,
    );
  else result.value = null;
}
function edit(id?: string) {
  const memory = items.value.find((item) => item.id === id);
  editing.value = memory?.id ?? "";
  content.value = memory?.content ?? "";
  priority.value = memory?.priority ?? 0;
  baseline.value = JSON.stringify([content.value, priority.value]);
  editorOpen.value = true;
}
async function save() {
  await run(async () => {
    await api(
      `/memories${editing.value ? `/${editing.value}` : ""}`,
      editing.value ? "PATCH" : "POST",
      { content: content.value, priority: priority.value },
    );
    baseline.value = JSON.stringify([content.value, priority.value]);
    editorOpen.value = false;
    await load();
    notice.value = "记忆已保存，将用于之后的新任务";
  });
}
async function remove(id: string) {
  if (
    await confirmAction(
      "删除此条记忆？之后的新任务不再使用它，已有聊天记录保留。",
      "删除记忆",
    )
  )
    await run(async () => {
      await api(`/memories/${id}`, "DELETE");
      await load();
    });
}
async function close(done: () => void) {
  if (!dirty.value || (await confirmAction("放弃尚未保存的记忆修改？"))) done();
}
onMounted(() => void run(load));
</script>
<template>
  <section>
    <div class="page-toolbar">
      <div>
        <h2>长期记忆</h2>
        <p>保存稳定偏好，让助手在之后的任务中更了解你。</p>
      </div>
      <el-button
        type="primary"
        :disabled="!loaded || items.length >= 100"
        @click="edit()"
        >添加记忆</el-button
      >
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"
      ><el-button text @click="run(load)">重新加载</el-button></el-alert
    ><el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <el-form class="inline-search" @submit.prevent="run(load)"
      ><el-input
        v-model="query"
        aria-label="记忆搜索关键词"
        placeholder="搜索记忆，留空查看全部"
        clearable
        maxlength="200"
      /><el-button native-type="submit" :loading="busy"
        >搜索记忆</el-button
      ></el-form
    >
    <p v-if="result">
      搜索最多返回 10 条相关记忆。{{
        result.truncated ? "结果已截断，请细化关键词。" : ""
      }}
    </p>
    <el-skeleton v-if="busy && !loaded" :rows="4" animated /><el-empty
      v-else-if="!visible.length"
      description="暂无记忆，添加你的偏好或换个关键词"
    />
    <div class="memory-grid">
      <el-card v-for="memory in visible" :key="memory.id" shadow="never"
        ><p class="preserve-lines">{{ memory.content }}</p>
        <div class="page-toolbar">
          <small class="muted">优先级 {{ memory.priority }}</small>
          <div>
            <el-button text :disabled="busy" @click="edit(memory.id)"
              >编辑</el-button
            ><el-button
              text
              type="danger"
              :disabled="busy"
              @click="remove(memory.id)"
              >删除</el-button
            >
          </div>
        </div></el-card
      >
    </div>
    <el-dialog
      v-model="editorOpen"
      :title="editing ? '编辑记忆' : '添加记忆'"
      width="520px"
      :before-close="close"
      destroy-on-close
      ><div class="feature-panel">
        <el-alert
          v-if="error"
          :title="error"
          type="error"
          :closable="false"
        /><el-form label-position="top" :disabled="busy" @submit.prevent="save"
          ><el-form-item label="记忆内容"
            ><el-input
              v-model="content"
              aria-label="记忆内容"
              type="textarea"
              :rows="5"
              maxlength="2000"
              show-word-limit
              required /></el-form-item
          ><el-form-item label="优先级"
            ><el-input-number
              v-model="priority"
              aria-label="记忆优先级"
              :min="-10"
              :max="10"
          /></el-form-item>
          <p>数值越高越优先。请勿保存密钥或密码。</p>
          <el-button
            type="primary"
            native-type="submit"
            :loading="busy"
            :disabled="!content.trim()"
            >保存记忆</el-button
          ></el-form
        >
      </div></el-dialog
    >
  </section>
</template>
