<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Conversation, Message } from '@mlclaw/shared';
import { useRoute, useRouter } from 'vue-router';
import { Plus, Search, MoreFilled, ChatLineRound, ArrowDown } from '@element-plus/icons-vue';
import { copyText as copy } from '../composables/clipboard';
import { modelLabel } from '../composables/taskLabels';
import { useChat, statusLabel } from '../stores/chat';
import { useSession } from '../stores/session';
import { api } from '../api';
import { confirmAction } from '../composables/confirm';
import { useDirtyGuard } from '../composables/dirty';
import { renderMarkdown } from '../markdown';
import ConversationRules from '../components/ConversationRules.vue';
import ConversationContext from '../components/ConversationContext.vue';
import AssistantAvatar from '../components/AssistantAvatar.vue';
/** 共享的会话与任务状态。 */
const chat = useChat();
/** 当前用户的登录与助手状态。 */
const session = useSession();
/** 将下拉选项映射为发送时使用的临时模型。 */
const selectedModel = computed({
  get: () => (chat.modelChoice ? JSON.stringify(chat.modelChoice) : 'default'),
  set: (value: string) => {
    chat.modelChoice = modelOptions.value.find((item) => item.value === value)?.choice;
  },
});
/** 只列出当前用户已经保存的模型。 */
const modelOptions = computed(() =>
  session.modelSettings.providers.flatMap((provider) =>
    provider.models.map((model) => {
      const choice = { providerId: provider.id, model };
      return { choice, value: JSON.stringify(choice), label: `${provider.name} / ${model}` };
    }),
  ),
);
/** 在模型菜单按钮中显示当前选择。 */
const selectedModelLabel = computed(() =>
  chat.modelChoice
    ? `${modelOptions.value.find((option) => option.value === selectedModel.value)?.label ?? chat.modelChoice.model}`
    : session.modelLabel,
);
/** 当前路由信息。 */
const route = useRoute();
/** 前端路由实例。 */
const router = useRouter();
/** 手机会话列表是否打开。 */
const mobileList = ref(false);
/** 当前详情内容。 */
const details = ref(false);
/** 工具展示偏好仅保存在当前浏览器，默认隐藏执行详情。 */
const toolVisibilityKey = 'mlclaw.chat.showTools';
const showTools = ref(false);
try {
  showTools.value = localStorage.getItem(toolVisibilityKey) === 'true';
} catch {
  // 浏览器禁止存储时沿用默认值，仍可在当前页面切换。
}
watch(showTools, (value) => {
  try {
    localStorage.setItem(toolVisibilityKey, String(value));
  } catch {
    // 存储不可用不影响当前页面的显示开关。
  }
});
/** 会话重命名对话框是否打开。 */
const renameOpen = ref(false);
/** 待保存的新会话标题。 */
const newTitle = ref('');
/** 会话补充规则是否尚未保存。 */
const rulesDirty = ref(false);
useDirtyGuard(rulesDirty);
/** 消息滚动容器的元素引用。 */
const viewport = ref<HTMLElement>();
/** 是否自动跟随新消息滚动到底部。 */
const following = ref(true);
/** 筛选后的记录。 */
const filtered = computed(() => chat.conversations);
/** 搜索输入防抖定时器。 */
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => chat.listQuery,
  () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void chat.load().catch((cause) => {
        chat.notice = cause instanceof Error ? cause.message : '会话搜索失败';
      });
    }, 250);
  },
);
onUnmounted(() => clearTimeout(searchTimer));
/** 当前表单草稿是否尚未保存。 */
const draftDirty = computed(() => renameOpen.value && newTitle.value !== chat.title);
useDirtyGuard(draftDirty);
/** 打开所选会话或资源。 */
const open = async (id: string) => {
  if (chat.busy) return;
  /** 本次操作的失败信息。 */
  const failure = await router.push(`/chat/${id}`);
  if (!failure) {
    mobileList.value = false;
    details.value = false;
    rulesDirty.value = false;
  }
};
/** 最新会话没有消息时复用，否则创建新会话。 */
const create = async () => {
  if (chat.busy) return;
  if (rulesDirty.value && !(await confirmAction('新建对话将丢弃未保存的规则，是否继续？'))) return;
  rulesDirty.value = false;
  details.value = false;
  await chat.action(async () => {
    /** 获取未经过搜索筛选的最新会话，避免依赖过期的列表状态。 */
    const { items } = await api<{ items: Conversation[] }>('/conversations/page');
    const latest = items[0];
    /** 以服务端消息记录判断是否为空，不使用标题或尚未加载的本地消息。 */
    const empty = latest
      ? !(await api<{ messages: Message[] }>(`/conversations/${latest.id}/messages`)).messages
          .length
      : false;
    /** 当前记录标识。 */
    const id = latest && empty ? latest.id : await chat.create();
    await router.push(`/chat/${id}`);
    mobileList.value = false;
  });
};
/** 处理会话菜单发出的操作指令。 */
const command = async (value: string) => {
  if (value === 'details') {
    details.value = true;
    return;
  }
  if (value === 'rename') {
    newTitle.value = chat.title;
    renameOpen.value = true;
    return;
  }
  if (
    value === 'remove' &&
    (await confirmAction(`删除“${chat.title}”及其消息和任务记录？此操作无法撤销。`, '删除对话'))
  )
    await chat.action(async () => {
      await api(`/conversations/${chat.selected}`, 'DELETE');
      await chat.load();
      await router.push('/chat');
    });
};
/** 保存会话的新标题。 */
const rename = async () => {
  await chat.action(async () => {
    await api(`/conversations/${chat.selected}`, 'PATCH', {
      title: newTitle.value,
    });
    chat.title = newTitle.value;
    renameOpen.value = false;
    await chat.load();
  });
};
/** 关闭详情前处理未保存的会话规则。 */
const closeDetails = async (done: () => void) => {
  if (!rulesDirty.value || (await confirmAction('关闭将丢弃尚未保存的会话规则，是否继续？'))) {
    rulesDirty.value = false;
    done();
  }
};
/** 关闭会话重命名对话框。 */
const closeRename = async (done: () => void) => {
  if (!draftDirty.value || (await confirmAction('放弃尚未保存的名称修改？'))) done();
};
/** 记录用户是否停留在消息底部。 */
const onScroll = () => {
  /** 当前消息滚动容器。 */
  const el = viewport.value;
  if (el) following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
};
/** 等待消息渲染后滚动到对话底部。 */
const bottom = async () => {
  following.value = true;
  await nextTick();
  /** 当前消息滚动容器。 */
  const el = viewport.value;
  if (el) el.scrollTop = el.scrollHeight;
};
/** 加载更早消息并保留当前滚动位置。 */
const older = async () => {
  /** 当前消息滚动容器。 */
  const el = viewport.value;
  if (!el) return;
  /** 加载历史消息前的滚动内容高度。 */
  const height = el.scrollHeight;
  /** 加载历史消息前的滚动偏移。 */
  const top = el.scrollTop;
  following.value = false;
  await chat.action(() => chat.loadMessages(true));
  await nextTick();
  el.scrollTop = top + el.scrollHeight - height;
};
/** 处理输入框发送快捷键并保护输入法组合输入。 */
const keydown = (event: Event | KeyboardEvent) => {
  if (!(event instanceof KeyboardEvent)) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!chat.busy && !chat.active && !chat.runtime) {
      void chat.send();
      void bottom();
    }
  }
};
watch(
  () => route.params.id,
  async (id) => {
    if (!route.path.startsWith('/chat')) return;
    /** 当前处理的值。 */
    const value = typeof id === 'string' ? id : '';
    if (value !== chat.selected || !chat.title) {
      await chat.select(value);
      await bottom();
    }
  },
  { immediate: true },
);
watch(
  () => [chat.liveText, chat.messages.length, chat.task?.tools?.length],
  async () => {
    if (following.value) await bottom();
  },
);
onMounted(() => {
  void chat.action(chat.load);
  void bottom();
});
</script>
<template>
  <div class="chat-layout">
    <aside class="conversation-sidebar" :class="{ 'is-open': mobileList }" aria-label="会话列表">
      <div class="conversation-actions">
        <el-button type="primary" :icon="Plus" :disabled="chat.busy" @click="create"
          >新建对话</el-button
        ><el-button class="close-conversations" text @click="mobileList = false">收起</el-button>
      </div>
      <el-input
        v-model="chat.listQuery"
        :prefix-icon="Search"
        aria-label="搜索会话标题"
        placeholder="搜索会话标题"
        clearable
      />
      <p class="muted small">按创建时间排列</p>
      <div class="conversation-items">
        <el-empty v-if="!filtered.length" :image-size="48" description="暂无匹配会话" /><button
          v-for="item in filtered"
          :key="item.id"
          class="conversation-item"
          :aria-current="chat.selected === item.id ? 'page' : undefined"
          :disabled="chat.busy"
          @click="open(item.id)"
        >
          <span>{{ item.title }}</span
          ><small>{{ item.created_at }}</small>
        </button>
      </div>
      <el-button
        v-if="chat.listCursor"
        text
        :loading="chat.listLoading"
        @click="chat.action(() => chat.load(true))"
        >加载更多会话</el-button
      ><el-button text :disabled="chat.busy" @click="chat.action(chat.load)"
        >刷新对话列表</el-button
      >
    </aside>
    <section class="chat-workspace">
      <header class="conversation-header">
        <el-button
          class="conversation-toggle"
          :icon="ChatLineRound"
          @click="mobileList = !mobileList"
          >会话</el-button
        >
        <div class="conversation-heading">
          <strong>{{ chat.title || '开始一段新对话' }}</strong
          ><small>全局默认模型：{{ session.modelLabel }}</small>
        </div>
        <el-switch
          v-model="showTools"
          class="tool-visibility-switch"
          active-text="显示工具调用"
          aria-label="显示工具调用"
        />
        <el-dropdown v-if="chat.selected" trigger="click" @command="command"
          ><el-button :icon="MoreFilled" aria-label="会话菜单" /><template #dropdown
            ><el-dropdown-menu
              ><el-dropdown-item command="rename">重命名</el-dropdown-item
              ><el-dropdown-item command="details">会话详情与规则</el-dropdown-item
              ><el-dropdown-item command="remove" :disabled="chat.active" divided
                >删除对话</el-dropdown-item
              ></el-dropdown-menu
            ></template
          ></el-dropdown
        >
      </header>
      <el-alert v-if="chat.notice" :title="chat.notice" type="error" show-icon :closable="false"
        ><el-button text @click="chat.select(chat.selected)">重新加载会话</el-button></el-alert
      >
      <div ref="viewport" class="message-viewport" @scroll="onScroll">
        <div class="message-column">
          <el-skeleton v-if="chat.loading" :rows="5" animated />
          <div v-else-if="!chat.selected || !chat.messages.length" class="chat-welcome">
            <AssistantAvatar :size="64" />
            <h1>
              {{ !session.assistantConfigured ? '先一起定义我是谁' : '今天有什么想一起完成？' }}
            </h1>
            <p v-if="!session.assistantConfigured">
              发送第一条消息，模型会通过简短对话与你共同完成身份设置。
            </p>
            <p v-else>整理思路、处理工作目录文件，或聊聊你的计划。</p>
            <el-alert
              v-if="session.modelLabel === '尚未指定'"
              title="先配置一个默认模型，即可开始对话"
              type="info"
              :closable="false"
              ><RouterLink to="/settings/models">前往模型设置 →</RouterLink></el-alert
            ><el-button v-if="!chat.selected" type="primary" @click="create">创建新对话</el-button>
            <div v-else-if="!session.assistantConfigured" class="suggestions">
              <el-button @click="chat.input = '我们开始设置你的身份吧'">开始身份设置</el-button>
            </div>
            <div v-else class="suggestions">
              <el-button
                v-for="text in [
                  '帮我整理今天的工作计划',
                  '列出工作目录中的文件',
                  '帮我梳理这个问题的思路',
                ]"
                :key="text"
                @click="chat.input = text"
                >{{ text }}</el-button
              >
            </div>
          </div>
          <el-button v-if="chat.nextCursor" text :loading="chat.busy" @click="older"
            >加载更早消息</el-button
          >
          <article
            v-for="message in chat.visibleMessages"
            :key="message.id"
            class="chat-message"
            :class="{ 'from-user': message.role === 'user' }"
          >
            <div class="message-meta">
              <span class="message-author">
                <AssistantAvatar v-if="message.role !== 'user'" />
                <strong>{{
                  message.role === 'user' ? '你' : session.assistantLabel
                }}</strong> </span
              ><el-button text size="small" aria-label="复制消息" @click="copy(message.content)"
                >复制</el-button
              >
            </div>
            <div class="markdown" v-html="renderMarkdown(message.content)"></div>
          </article>
          <article v-if="chat.active && chat.liveText" class="chat-message">
            <div class="message-author">
              <AssistantAvatar /><strong>{{ session.assistantLabel }}</strong>
            </div>
            <div class="markdown" v-html="renderMarkdown(chat.liveText)"></div>
          </article>
          <div v-if="chat.task" class="task-process" aria-label="本次执行">
            <el-tag
              :type="chat.task.status === 'failed' ? 'danger' : chat.active ? 'warning' : 'info'"
              >{{ statusLabel(chat.task.status) }}</el-tag
            >
            <p v-if="chat.task.error" role="alert">{{ chat.task.error }}</p>
            <el-collapse
              v-if="showTools && (chat.task.tools?.length || chat.task.skills?.length)"
              :key="chat.task.id"
              ><el-collapse-item
                :title="`执行过程 · ${chat.task.tools?.length ?? 0} 项工具操作`"
                name="process"
                ><p v-for="(skill, index) in chat.task.skills" :key="index">
                  已加载 {{ skill.name }} · 版本 {{ skill.version }} ·
                  {{ skill.resource ?? '技能说明' }} · {{ skill.loadedAt }}
                </p>
                <el-collapse class="tool-calls">
                  <el-collapse-item
                    v-for="tool in chat.task.tools"
                    :key="tool.id"
                    :name="tool.id"
                    :title="`${tool.name} · ${statusLabel(tool.status)}`"
                  >
                    <p class="muted">调用参数</p>
                    <pre>{{ tool.arguments }}</pre>
                    <p class="muted">调用结果</p>
                    <pre v-if="tool.result !== null">{{ tool.result || '（空结果）' }}</pre>
                    <p v-else class="muted">
                      {{
                        ['queued', 'running'].includes(tool.status)
                          ? '等待工具返回结果…'
                          : '暂无结果'
                      }}
                    </p>
                  </el-collapse-item>
                </el-collapse>
                <p v-if="chat.task.model_snapshot">
                  实际模型：{{ modelLabel(chat.task.model_snapshot) }}
                </p></el-collapse-item
              ></el-collapse
            >
            <el-button
              v-if="
                chat.task.kind !== 'summary' &&
                ['failed', 'cancelled', 'interrupted'].includes(chat.task.status)
              "
              :disabled="chat.busy || !!chat.runtime"
              @click="chat.send(chat.task!.input, true)"
              >以新任务重试</el-button
            >
          </div>
          <el-alert v-if="chat.connection" :title="chat.connection" type="warning" :closable="false"
            ><el-button text @click="chat.select(chat.selected)">重新连接</el-button></el-alert
          >
          <p v-if="chat.contextNotice" role="status">
            {{ chat.contextNotice }}
          </p>
        </div>
      </div>
      <footer v-if="chat.selected" class="composer">
        <el-button v-if="!following" class="back-latest" size="small" @click="bottom"
          >回到最新</el-button
        >
        <div class="composer-inner">
          <el-input
            v-model="chat.input"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 7 }"
            aria-label="消息"
            placeholder="输入消息，和助手一起完成任务…"
            maxlength="8000"
            resize="none"
            @keydown="keydown"
          />
          <div class="composer-toolbar">
            <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span
            ><span class="header-spacer" />
            <el-dropdown
              trigger="click"
              placement="top-end"
              :max-height="320"
              :disabled="chat.busy || chat.loading || chat.active || !!chat.runtime"
              class="composer-model"
              @command="(value: string) => (selectedModel = value)"
            >
              <span
                class="composer-model-trigger"
                :class="{
                  'is-disabled': chat.busy || chat.loading || chat.active || !!chat.runtime,
                }"
                role="button"
                aria-label="本次对话模型"
                :aria-disabled="chat.busy || chat.loading || chat.active || !!chat.runtime"
                :tabindex="chat.busy || chat.loading || chat.active || !!chat.runtime ? -1 : 0"
              >
                <span class="composer-model-label">{{ selectedModelLabel }}</span>
                <el-icon><ArrowDown /></el-icon>
              </span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item
                    v-for="option in modelOptions"
                    :key="option.value"
                    :command="option.value"
                    :disabled="selectedModel === option.value"
                  >
                    {{ option.label }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button
              v-if="chat.active"
              type="danger"
              plain
              :loading="chat.busy"
              @click="chat.cancel"
              >停止生成</el-button
            ><el-button
              v-else
              type="primary"
              :loading="chat.busy"
              :disabled="
                !chat.input.trim() ||
                chat.loading ||
                !!chat.runtime ||
                (!chat.modelChoice && session.modelLabel === '尚未指定')
              "
              @click="
                chat.send();
                bottom();
              "
              >发送</el-button
            >
          </div>
        </div>
      </footer>
    </section>
    <el-drawer
      v-model="details"
      title="会话详情与规则"
      size="520px"
      destroy-on-close
      :before-close="closeDetails"
      ><div class="feature-panel">
        <ConversationRules
          v-if="chat.selected"
          :key="chat.selected"
          :conversation-id="chat.selected"
          @dirty="rulesDirty = $event"
          @expired="session.clear"
        /><ConversationContext
          v-if="chat.selected"
          :conversation-id="chat.selected"
          :active="chat.active || !!chat.runtime"
          @expired="session.clear"
          @started="(id) => chat.select(chat.selected)"
        /></div
    ></el-drawer>
    <el-dialog v-model="renameOpen" title="重命名对话" width="440px" :before-close="closeRename"
      ><el-form @submit.prevent="rename"
        ><el-input v-model="newTitle" aria-label="对话名称" maxlength="100" required />
        <div class="dialog-actions">
          <el-button
            native-type="submit"
            type="primary"
            :disabled="!newTitle.trim()"
            :loading="chat.busy"
            >保存名称</el-button
          >
        </div></el-form
      ></el-dialog
    >
  </div>
</template>
