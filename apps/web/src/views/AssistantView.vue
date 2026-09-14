<script setup lang="ts">
import { useSession } from '../stores/session';
import { useDirtyGuard } from '../composables/dirty';
import { confirmAction } from '../composables/confirm';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { AssistantConfig, AssistantPreview, AssistantSettings } from '@mlclaw/shared';
import { api, ApiError } from '../api';
import { createUuid } from '../uuid';
import { renderMarkdown } from '../markdown';
import AssistantTemplates from '../components/AssistantTemplates.vue';
import ImageSettings from '../components/ImageSettings.vue';

/** 当前用户的登录与助手状态。 */
const session = useSession();
/** 已保存的记录或响应。 */
const saved = ref<AssistantSettings | null>(null);
/** 可编辑的当前草稿。 */
const draft = ref<AssistantConfig | null>(null);
/** 操作进行中标记，用于禁用重复提交。 */
const busy = ref(false);
/** 当前错误提示。 */
const error = ref('');
/** 当前操作反馈文案。 */
const notice = ref('');
/** 当前面板是否打开。 */
const open = ref(true);
/** 当前选中的页签。 */
const tab = ref('身份');
/** 可切换的页签配置。 */
const tabs = ['身份', '性格', '用户资料', '规则', '工具约定'];
/** 当前预览数据。 */
const preview = ref<AssistantPreview | null>(null);
/** 当前草稿是否偏离已保存内容。 */
const dirty = computed(
  () => !!draft.value && JSON.stringify(draft.value) !== JSON.stringify(saved.value?.config),
);
/** 首次设置时展示的助手欢迎状态。 */
const welcome = computed(() => saved.value && !saved.value.config.onboardingCompleted);
/** 统一执行页面操作并处理错误与忙碌状态。 */
const perform = async (fn: () => Promise<void>) => {
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
/** 接收服务端配置并同步编辑草稿与基线。 */
const accept = (value: AssistantSettings) => {
  saved.value = value;
  draft.value = JSON.parse(JSON.stringify(value.config)) as AssistantConfig;
  preview.value = null;
  session.updateAssistant(value.config);
};
/** 加载当前页面或业务所需的数据。 */
const load = async () => {
  await perform(async () => {
    accept(await api<AssistantSettings>('/settings/assistant'));
  });
};
/** 重新加载数据并重置相关界面状态。 */
const reload = async () => {
  if (dirty.value && !(await confirmAction('重新加载会丢弃尚未保存的修改，是否继续？'))) return;
  await load();
};
/** 校验并保存当前编辑内容。 */
const save = async () => {
  if (!draft.value || !saved.value) return;
  await perform(async () => {
    /** 当前流程使用的配置。 */
    const config = { ...draft.value!, onboardingCompleted: true };
    accept(
      await api<AssistantSettings>('/settings/assistant', 'PUT', {
        config,
        expectedVersion: saved.value!.version,
      }),
    );
    notice.value = '助手配置已保存，从下一次提交消息生效';
  });
};
/** 在助手规则列表末尾添加一条空规则。 */
const addRule = () => {
  draft.value?.rules.push({
    id: createUuid(),
    content: '',
    enabled: true,
  });
};
/** 按指定偏移调整规则顺序。 */
const moveRule = (index: number, step: number) => {
  /** 当前规则列表。 */
  const rules = draft.value?.rules;
  if (!rules || index + step < 0 || index + step >= rules.length) return;
  /** 本次移动或编辑的规则条目。 */
  const [rule] = rules.splice(index, 1);
  if (rule) rules.splice(index + step, 0, rule);
};
/** 请求并展示当前配置的上下文预览。 */
const showPreview = async () => {
  if (draft.value)
    await perform(async () => {
      preview.value = await api<AssistantPreview>('/settings/assistant/preview', 'POST', {
        config: draft.value,
      });
    });
};
/** 存在未保存内容时触发浏览器离开提示。 */
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = '';
  }
};
watch(
  draft,
  () => {
    preview.value = null;
  },
  { deep: true },
);
onMounted(() => {
  void load();
  window.addEventListener('beforeunload', beforeUnload);
});
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));

useDirtyGuard(dirty);
</script>

<template>
  <div class="page-content feature-panel">
    <ImageSettings
      title="AI 头像"
      description="用于对话消息和新建对话欢迎页，上传后自动保存。"
      endpoint="/settings/assistant-avatar"
      kind="avatar"
      @change="session.assistantAvatarUrl = $event.url"
    />
    <section aria-label="助手配置">
      <h2>助手设置</h2>
      <p v-if="welcome">身份尚未设置。可以在第一次对话中由模型引导完成，也可以在此手动填写。</p>
      <p v-if="busy" role="status">正在处理助手设置…</p>
      <p v-if="error" role="alert">
        {{ error }}
        <el-button :disabled="busy" @click="reload" native-type="submit"
          >重新加载助手配置</el-button
        >
      </p>
      <el-alert v-if="notice" :title="notice" type="info" :closable="false" show-icon />
      <template v-if="open && draft && saved">
        <p>当前版本：{{ saved.version }}。保存后影响下一次提交，运行中的任务继续使用原配置。</p>
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
                ><el-input aria-label="助手名称" v-model="draft.name" required maxlength="80"
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
                ><el-input aria-label="如何称呼你" v-model="draft.userName" maxlength="80"
              /></el-form-item>
              <el-form-item
                ><template #label>交流语言</template
                ><el-input aria-label="交流语言" v-model="draft.language" required maxlength="80"
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
              <p>规则用于工作习惯，不能更改目录权限。最多 30 条，按显示顺序组织。</p>
              <p v-if="!draft.rules.length">尚无行为规则，可以按需添加。</p>
              <div v-for="(rule, index) in draft.rules" :key="rule.id" class="assistant-rule">
                <el-form-item
                  ><template #label>规则 {{ index + 1 }} 内容</template
                  ><el-input type="textarea" v-model="rule.content" maxlength="2000" :rows="3"
                /></el-form-item>
                <el-form-item
                  ><el-checkbox v-model="rule.enabled"
                    >启用规则 {{ index + 1 }}</el-checkbox
                  ></el-form-item
                >
                <el-button native-type="button" :disabled="index === 0" @click="moveRule(index, -1)"
                  >上移规则 {{ index + 1 }}</el-button
                >
                <el-button
                  native-type="button"
                  :disabled="index === draft.rules.length - 1"
                  @click="moveRule(index, 1)"
                  >下移规则 {{ index + 1 }}</el-button
                >
                <el-button native-type="button" @click="draft.rules.splice(index, 1)"
                  >删除规则 {{ index + 1 }}</el-button
                >
              </div>
              <el-button native-type="button" :disabled="draft.rules.length >= 30" @click="addRule"
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
            <el-button native-type="button" @click="showPreview">预览上下文</el-button>
            <el-button native-type="button" @click="reload">重新加载已保存配置</el-button>
          </fieldset>
        </el-form>
        <section v-if="preview" aria-label="上下文预览">
          <h3>上下文预览</h3>
          <p>
            本预览不调用模型、不保存配置，不包含会话历史。字符数仅描述配置文本大小，容量由模型服务判断。
          </p>
          <p>配置与工具定义共 {{ preview.budget.used }} 字符。</p>
          <details v-for="part in preview.sections" :key="part.source">
            <summary>{{ part.source }} · {{ part.characters }} 字符</summary>
            <pre>{{ part.content }}</pre>
          </details>
          <details>
            <summary>性格 Markdown 效果</summary>
            <div class="markdown" v-html="renderMarkdown(draft.personality)"></div>
          </details>
        </section>
        <AssistantTemplates
          :config="draft"
          :disabled="busy"
          @expired="session.clear()"
          @apply="
            (config) => {
              draft = config;
              notice = '已应用到草稿，请检查后保存助手配置';
            }
          "
        />
      </template>
    </section>
  </div>
</template>
