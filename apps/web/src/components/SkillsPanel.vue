<script setup lang="ts">
import { useDirtyGuard } from "../composables/dirty";
import { confirmAction } from "../composables/confirm";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { Skill, SkillInput, SkillSearch } from "@mlclaw/shared";
import { api, ApiError } from "../api";
import { renderMarkdown } from "../markdown";

const emit = defineEmits<{ expired: []; dirty: [value: boolean] }>();
const empty = (): SkillInput => ({
  name: "",
  description: "",
  keywords: [],
  content: "",
  enabled: true,
  resources: [],
});
const items = ref<Skill[]>([]);
const draft = ref<SkillInput>(empty());
const selected = ref<Skill | null>(null);
const keywordText = ref("");
const busy = ref(false);
const loaded = ref(false);
const error = ref("");
const notice = ref("");
const editorOpen = ref(false);
const preview = ref(false);
const query = ref("");
const results = ref<SkillSearch | null>(null);
const serialized = () => JSON.stringify([draft.value, keywordText.value]);
const original = ref(serialized());
const dirty = computed(() => loaded.value && serialized() !== original.value);
let alive = true;
watch(dirty, (value) => emit("dirty", value));
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
async function mayReplace() {
  return (
    !dirty.value ||
    (await confirmAction("此操作将丢弃未保存的技能修改，是否继续？"))
  );
}
function apply(skill: Skill | null) {
  selected.value = skill;
  draft.value = skill
    ? {
        name: skill.name,
        description: skill.description,
        keywords: [...skill.keywords],
        content: skill.content,
        enabled: skill.enabled,
        resources: skill.resources.map((item) => ({ ...item })),
      }
    : empty();
  keywordText.value = skill?.keywords.join("，") ?? "";
  original.value = serialized();
  preview.value = false;
}
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
    error.value =
      cause instanceof Error ? cause.message : "技能操作失败，请重试";
  } finally {
    if (alive) busy.value = false;
  }
}
async function load() {
  if (!(await mayReplace())) return;
  await action(async () => {
    const result = await api<{ skills: Skill[] }>("/skills");
    if (!alive) return;
    items.value = result.skills;
    results.value = null;
    loaded.value = true;
    apply(items.value.find((item) => item.id === selected.value?.id) ?? null);
  });
}
async function edit(skill: Skill | null) {
  if (!(await mayReplace())) return;
  error.value = "";
  notice.value = "";
  apply(skill);
  editorOpen.value = true;
}
async function save() {
  await action(async () => {
    const skill = {
      ...draft.value,
      keywords: keywordText.value
        .split(/[,，\n]/)
        .map((word) => word.trim())
        .filter(Boolean),
    };
    const result = await api<Skill>(
      selected.value ? `/skills/${selected.value.id}` : "/skills",
      selected.value ? "PUT" : "POST",
      selected.value
        ? { skill, expectedVersion: selected.value.version }
        : skill,
    );
    if (!alive) return;
    items.value = [
      ...items.value.filter((item) => item.id !== result.id),
      result,
    ].sort((a, b) => a.name.localeCompare(b.name));
    apply(result);
    results.value = null;
    notice.value = "技能已保存；启用的技能可由助手自动选择，无需手动勾选。";
  });
}
async function remove() {
  if (
    !selected.value ||
    !(await confirmAction(
      "删除此技能及参考文档？之后的读取会停止，历史加载记录保留。",
    ))
  )
    return;
  await action(async () => {
    const id = selected.value!.id;
    await api(`/skills/${id}`, "DELETE", {
      expectedVersion: selected.value!.version,
    });
    if (!alive) return;
    items.value = items.value.filter((item) => item.id !== id);
    apply(null);
    results.value = null;
    notice.value = "技能已删除";
    editorOpen.value = false;
  });
}
async function search() {
  await action(async () => {
    const result = await api<SkillSearch>(
      `/skills/search?q=${encodeURIComponent(query.value)}`,
    );
    if (alive) results.value = result;
  });
}
onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  void load();
});
onUnmounted(() => {
  alive = false;
  window.removeEventListener("beforeunload", beforeUnload);
  emit("dirty", false);
});

useDirtyGuard(dirty);
async function back() {
  if (await mayReplace()) {
    original.value = serialized();
    editorOpen.value = false;
  }
}
</script>

<template>
  <section class="settings-panel" aria-label="技能管理">
    <h2>技能 · 自动匹配工作流程</h2>
    <p>
      保存并启用技能后，助手会按任务判断是否需要，先读取说明，再按需读取参考文档。关键词搜索只提供候选，不会直接执行。
    </p>
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
    <p v-if="busy" role="status">正在处理技能…</p>
    <el-button :disabled="busy" @click="load" native-type="submit"
      >重新加载技能</el-button
    >
    <template v-if="loaded">
      <div v-if="!editorOpen">
        <p v-if="!items.length">尚未创建技能。</p>
        <article
          v-for="item in items"
          :key="item.id"
          :aria-label="`技能：${item.name}`"
        >
          <strong>{{ item.name }}</strong>
          <p>{{ item.description }}</p>
          <p>
            {{ item.enabled ? "已启用 · 允许自动选择" : "已停用" }} · 版本
            {{ item.version }}
          </p>
          <el-button :disabled="busy" @click="edit(item)" native-type="submit"
            >编辑技能</el-button
          >
        </article>
        <el-button
          :disabled="busy || items.length >= 30"
          @click="edit(null)"
          native-type="submit"
          >新增技能</el-button
        >
      </div>
      <div v-if="editorOpen" class="skill-editor">
        <el-button text @click="back">← 返回技能列表</el-button>
        <p v-if="dirty" role="status">技能有未保存的修改。</p>
        <el-form label-position="top" :disabled="busy" @submit.prevent="save">
          <fieldset :disabled="busy">
            <legend>
              {{ selected ? `编辑 ${selected.name}` : "创建技能" }}
            </legend>
            <el-form-item
              ><template #label>技能名称</template
              ><el-input
                aria-label="技能名称"
                v-model="draft.name"
                required
                maxlength="64"
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="例如 weekly-report"
            /></el-form-item>
            <el-form-item
              ><template #label>适用场景描述</template
              ><el-input
                aria-label="适用场景描述"
                type="textarea"
                v-model="draft.description"
                required
                maxlength="300"
                :rows="3"
                placeholder="说明何时使用、何时不使用；助手据此判断是否适合当前任务。"
            /></el-form-item>
            <el-form-item
              ><template #label>匹配关键词</template
              ><el-input
                aria-label="匹配关键词"
                v-model="keywordText"
                maxlength="310"
                placeholder="例如 周报，总结工作，汇总进展"
            /></el-form-item>
            <p>可选，逗号分隔，最多 10 个，每个不超过 30 字符。</p>
            <el-form-item
              ><el-checkbox v-model="draft.enabled"
                >启用并允许自动匹配</el-checkbox
              ></el-form-item
            >
            <el-form-item
              ><template #label>技能说明（Markdown）</template
              ><el-input
                aria-label="技能说明（Markdown）"
                type="textarea"
                v-model="draft.content"
                required
                maxlength="8000"
                :rows="10"
                placeholder="写清输入、执行步骤、结果格式和必要检查。需引用参考文档时写明其名称。"
            /></el-form-item>
            <p>
              正文最多 8000 字符；仅保存说明文字，不安装脚本或新增工具权限。
            </p>
            <fieldset v-for="(resource, index) in draft.resources" :key="index">
              <legend>参考文档 {{ index + 1 }}</legend>
              <label :for="`skill-resource-name-${index}`"
                >文档 {{ index + 1 }} 名称</label
              ><el-input
                :id="`skill-resource-name-${index}`"
                v-model="resource.name"
                required
                maxlength="64"
                placeholder="例如 checklist.md"
              />
              <label :for="`skill-resource-content-${index}`"
                >文档 {{ index + 1 }} 正文</label
              ><el-input
                type="textarea"
                :id="`skill-resource-content-${index}`"
                v-model="resource.content"
                required
                maxlength="4000"
                :rows="5"
              />
              <el-button
                native-type="button"
                @click="draft.resources.splice(index, 1)"
                >移除参考文档 {{ index + 1 }}</el-button
              >
            </fieldset>
            <el-button
              native-type="button"
              :disabled="draft.resources.length >= 5"
              @click="draft.resources.push({ name: '', content: '' })"
              >添加参考文档</el-button
            >
            <el-button native-type="button" @click="preview = !preview">{{
              preview ? "收起技能预览" : "预览技能说明"
            }}</el-button>
            <section v-if="preview" aria-label="技能说明预览">
              <div
                class="markdown"
                v-html="renderMarkdown(draft.content)"
              ></div>
              <article v-for="resource in draft.resources" :key="resource.name">
                <h4>{{ resource.name }}</h4>
                <div
                  class="markdown"
                  v-html="renderMarkdown(resource.content)"
                ></div>
              </article>
            </section>
            <el-button type="primary" :disabled="!dirty" native-type="submit"
              >保存技能</el-button
            ><el-button v-if="selected" native-type="button" @click="remove"
              >删除技能</el-button
            >
          </fieldset>
        </el-form>
      </div>
      <el-form
        v-if="!editorOpen"
        label-position="top"
        :disabled="busy"
        @submit.prevent="search"
        ><el-form-item
          ><template #label>技能试查关键词</template
          ><el-input
            aria-label="技能试查关键词"
            v-model="query"
            required
            maxlength="200" /></el-form-item
        ><el-button :disabled="busy || !query.trim()" native-type="submit"
          >搜索技能候选</el-button
        ></el-form
      >
      <p>
        试查搜索已保存且启用的技能名称、描述、关键词、正文及参考文档，不调用模型。模型还会结合任务含义判断。
      </p>
      <template v-if="results && !editorOpen"
        ><p v-if="!results.items.length">没有匹配的已启用技能。</p>
        <p v-if="results.truncated">仅显示部分候选，请细化关键词。</p>
        <article
          v-for="result in results.items"
          :key="result.id"
          aria-label="技能候选"
        >
          <strong>{{ result.name }} · 版本 {{ result.version }}</strong>
          <p>匹配位置：{{ result.source }}</p>
          <pre>{{ result.excerpt }}</pre>
        </article>
      </template>
    </template>
  </section>
</template>
