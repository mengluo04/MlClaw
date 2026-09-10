<script setup lang="ts">
import { useDirtyGuard } from "../composables/dirty";
import { confirmAction } from "../composables/confirm";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type {
  AssistantConfig,
  AssistantPreview,
  AssistantSettings,
} from "@mlclaw/shared";
import { api, ApiError } from "../api";
import { renderMarkdown } from "../markdown";
import AssistantTemplates from "./AssistantTemplates.vue";

const emit = defineEmits<{ saved: [config: AssistantConfig]; expired: [] }>();
const saved = ref<AssistantSettings | null>(null);
const draft = ref<AssistantConfig | null>(null);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const open = ref(true);
const tab = ref("身份");
const tabs = ["身份", "性格", "用户资料", "规则", "工具约定"];
const preview = ref<AssistantPreview | null>(null);
const dirty = computed(
  () =>
    !!draft.value &&
    JSON.stringify(draft.value) !== JSON.stringify(saved.value?.config),
);
const welcome = computed(
  () => saved.value && !saved.value.config.onboardingCompleted,
);
async function perform(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) emit("expired");
    error.value = cause instanceof Error ? cause.message : "操作失败，请重试";
  } finally {
    busy.value = false;
  }
}
function accept(value: AssistantSettings) {
  saved.value = value;
  draft.value = JSON.parse(JSON.stringify(value.config)) as AssistantConfig;
  preview.value = null;
  emit("saved", value.config);
}
async function load() {
  await perform(async () => {
    accept(await api<AssistantSettings>("/settings/assistant"));
  });
}
async function reload() {
  if (
    dirty.value &&
    !(await confirmAction("重新加载会丢弃尚未保存的修改，是否继续？"))
  )
    return;
  await load();
}
async function save(skip = false) {
  if (!draft.value || !saved.value) return;
  await perform(async () => {
    const config = skip
      ? { ...saved.value!.config, onboardingCompleted: true }
      : { ...draft.value!, onboardingCompleted: true };
    accept(
      await api<AssistantSettings>("/settings/assistant", "PUT", {
        config,
        expectedVersion: saved.value!.version,
      }),
    );
    notice.value = skip
      ? "已跳过首次设置，可随时打开助手设置"
      : "助手配置已保存，从下一次提交消息生效";
  });
}
function addRule() {
  draft.value?.rules.push({
    id: crypto.randomUUID(),
    content: "",
    enabled: true,
  });
}
function moveRule(index: number, step: number) {
  const rules = draft.value?.rules;
  if (!rules || index + step < 0 || index + step >= rules.length) return;
  const [rule] = rules.splice(index, 1);
  if (rule) rules.splice(index + step, 0, rule);
}
async function showPreview() {
  if (draft.value)
    await perform(async () => {
      preview.value = await api<AssistantPreview>(
        "/settings/assistant/preview",
        "POST",
        { config: draft.value },
      );
    });
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
watch(
  draft,
  () => {
    preview.value = null;
  },
  { deep: true },
);
onMounted(() => {
  void load();
  window.addEventListener("beforeunload", beforeUnload);
});
onUnmounted(() => window.removeEventListener("beforeunload", beforeUnload));

useDirtyGuard(dirty);
</script>

<template>
  <section aria-label="助手配置">
    <h2>助手设置</h2>
    <p v-if="welcome">
      为助手设置名字、表达方式和你的偏好，也可以直接使用默认配置。
    </p>

    <el-button
      v-if="welcome"
      native-type="button"
      :disabled="busy || dirty"
      @click="save(true)"
      >跳过首次设置</el-button
    >
    <p v-if="busy" role="status">正在处理助手设置…</p>
    <p v-if="error" role="alert">
      {{ error }}
      <el-button :disabled="busy" @click="reload" native-type="submit"
        >重新加载助手配置</el-button
      >
    </p>
    <el-alert
      v-if="notice"
      :title="notice"
      type="info"
      :closable="false"
      show-icon
    />
    <template v-if="open && draft && saved">
      <p>
        当前版本：{{
          saved.version
        }}。保存后影响下一次提交，运行中的任务继续使用原配置。
      </p>
      <p v-if="dirty" role="status">有尚未保存的修改</p>
      <nav aria-label="助手设置分类">
        <el-button
          v-for="item in tabs"
          :key="item"
          native-type="button"
          :aria-pressed="tab === item"
          @click="tab = item"
          >{{ item }}</el-button
        >
      </nav>
      <el-form label-position="top" :disabled="busy" @submit.prevent="save()">
        <fieldset :disabled="busy">
          <div v-show="tab === '身份'">
            <el-form-item
              ><template #label>助手名称</template
              ><el-input
                aria-label="助手名称"
                v-model="draft.name"
                required
                maxlength="80"
            /></el-form-item>
            <el-form-item
              ><template #label>助手 Emoji</template
              ><el-input
                aria-label="助手 Emoji"
                v-model="draft.emoji"
                maxlength="32"
            /></el-form-item>
            <el-form-item
              ><template #label>角色简介</template
              ><el-input
                aria-label="角色简介"
                type="textarea"
                v-model="draft.description"
                maxlength="1000"
                :rows="3"
            /></el-form-item>
          </div>
          <div v-show="tab === '性格'">
            <el-form-item
              ><template #label>性格与表达（Markdown）</template
              ><el-input
                aria-label="性格与表达（Markdown）"
                type="textarea"
                v-model="draft.personality"
                maxlength="3000"
                :rows="6"
            /></el-form-item>
          </div>
          <div v-show="tab === '用户资料'">
            <el-form-item
              ><template #label>如何称呼你</template
              ><el-input
                aria-label="如何称呼你"
                v-model="draft.userName"
                maxlength="80"
            /></el-form-item>
            <el-form-item
              ><template #label>交流语言</template
              ><el-input
                aria-label="交流语言"
                v-model="draft.language"
                required
                maxlength="80"
            /></el-form-item>
            <el-form-item
              ><template #label>用户时区</template
              ><el-input
                aria-label="用户时区"
                v-model="draft.timezone"
                required
                maxlength="100"
                placeholder="Asia/Shanghai"
            /></el-form-item>
            <el-form-item
              ><template #label>背景与稳定偏好（Markdown）</template
              ><el-input
                aria-label="背景与稳定偏好（Markdown）"
                type="textarea"
                v-model="draft.userBackground"
                maxlength="3000"
                :rows="5"
            /></el-form-item>
          </div>
          <div v-show="tab === '规则'">
            <p>
              规则用于工作习惯，不能代替工具批准或更改目录权限。最多 30
              条，按显示顺序组织。
            </p>
            <p v-if="!draft.rules.length">尚无行为规则，可以按需添加。</p>
            <div
              v-for="(rule, index) in draft.rules"
              :key="rule.id"
              class="assistant-rule"
            >
              <el-form-item
                ><template #label>规则 {{ index + 1 }} 内容</template
                ><el-input
                  type="textarea"
                  v-model="rule.content"
                  maxlength="2000"
                  :rows="3"
              /></el-form-item>
              <el-form-item
                ><el-checkbox v-model="rule.enabled"
                  >启用规则 {{ index + 1 }}</el-checkbox
                ></el-form-item
              >
              <el-button
                native-type="button"
                :disabled="index === 0"
                @click="moveRule(index, -1)"
                >上移规则 {{ index + 1 }}</el-button
              >
              <el-button
                native-type="button"
                :disabled="index === draft.rules.length - 1"
                @click="moveRule(index, 1)"
                >下移规则 {{ index + 1 }}</el-button
              >
              <el-button
                native-type="button"
                @click="draft.rules.splice(index, 1)"
                >删除规则 {{ index + 1 }}</el-button
              >
            </div>
            <el-button
              native-type="button"
              :disabled="draft.rules.length >= 30"
              @click="addRule"
              >添加行为规则</el-button
            >
          </div>
          <div v-show="tab === '工具约定'">
            <el-form-item
              ><template #label>工具使用约定（Markdown）</template
              ><el-input
                aria-label="工具使用约定（Markdown）"
                type="textarea"
                v-model="draft.toolNotes"
                maxlength="2000"
                :rows="5"
            /></el-form-item>
          </div>
          <el-button
            type="primary"
            :disabled="!dirty && saved.config.onboardingCompleted"
            native-type="submit"
            >保存助手配置</el-button
          >
          <el-button native-type="button" @click="showPreview"
            >预览上下文</el-button
          >
          <el-button native-type="button" @click="reload"
            >重新加载已保存配置</el-button
          >
        </fieldset>
      </el-form>
      <section v-if="preview" aria-label="上下文预览">
        <h3>上下文预览</h3>
        <p>
          本预览不调用模型、不保存配置，不包含会话历史。显示字符预算，非精确
          token 数。
        </p>
        <p>
          占用 {{ preview.budget.used }} /
          {{ preview.budget.limit }} 字符；输出预留
          {{ preview.budget.outputReserve }}，工具循环预留
          {{ preview.budget.toolReserve }}。
        </p>
        <details v-for="part in preview.sections" :key="part.source">
          <summary>{{ part.source }} · {{ part.characters }} 字符</summary>
          <pre>{{ part.content }}</pre>
        </details>
        <details>
          <summary>性格 Markdown 效果</summary>
          <div
            class="markdown"
            v-html="renderMarkdown(draft.personality)"
          ></div>
        </details>
      </section>
      <AssistantTemplates
        :config="draft"
        :disabled="busy"
        @expired="emit('expired')"
        @apply="
          (config) => {
            draft = config;
            notice = '已应用到草稿，请检查后保存助手配置';
          }
        "
      />
    </template>
  </section>
</template>
