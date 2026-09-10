<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Plus,
  Search,
  MoreFilled,
  ChatLineRound,
} from "@element-plus/icons-vue";
import { copyText as copy } from "../composables/clipboard";
import { modelLabel } from "../composables/taskLabels";
import { useChat, statusLabel } from "../stores/chat";
import { useSession } from "../stores/session";
import { api } from "../api";
import { confirmAction } from "../composables/confirm";
import { useDirtyGuard } from "../composables/dirty";
import { renderMarkdown } from "../markdown";
import ConversationRules from "../components/ConversationRules.vue";
import ConversationContext from "../components/ConversationContext.vue";
const chat = useChat();
const session = useSession();
const route = useRoute();
const router = useRouter();
const mobileList = ref(false);
const details = ref(false);
const renameOpen = ref(false);
const newTitle = ref("");
const rulesDirty = ref(false);
useDirtyGuard(rulesDirty);
const viewport = ref<HTMLElement>();
const following = ref(true);
const filtered = computed(() => chat.conversations);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => chat.listQuery,
  () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void chat.load().catch((cause) => {
        chat.notice = cause instanceof Error ? cause.message : "会话搜索失败";
      });
    }, 250);
  },
);
onUnmounted(() => clearTimeout(searchTimer));
const draftDirty = computed(
  () => renameOpen.value && newTitle.value !== chat.title,
);
useDirtyGuard(draftDirty);
async function open(id: string) {
  if (chat.busy) return;
  const failure = await router.push(`/chat/${id}`);
  if (!failure) {
    mobileList.value = false;
    details.value = false;
    rulesDirty.value = false;
  }
}
async function create() {
  if (
    rulesDirty.value &&
    !(await confirmAction("新建对话将丢弃未保存的规则，是否继续？"))
  )
    return;
  rulesDirty.value = false;
  details.value = false;
  await chat.action(async () => {
    const id = await chat.create();
    await router.push(`/chat/${id}`);
    mobileList.value = false;
  });
}
async function command(value: string) {
  if (value === "details") {
    details.value = true;
    return;
  }
  if (value === "rename") {
    newTitle.value = chat.title;
    renameOpen.value = true;
    return;
  }
  if (
    value === "remove" &&
    (await confirmAction(
      `删除“${chat.title}”及其消息和任务记录？此操作无法撤销。`,
      "删除对话",
    ))
  )
    await chat.action(async () => {
      await api(`/conversations/${chat.selected}`, "DELETE");
      await chat.load();
      await router.push("/chat");
    });
}
async function rename() {
  await chat.action(async () => {
    await api(`/conversations/${chat.selected}`, "PATCH", {
      title: newTitle.value,
    });
    chat.title = newTitle.value;
    renameOpen.value = false;
    await chat.load();
  });
}
async function closeDetails(done: () => void) {
  if (
    !rulesDirty.value ||
    (await confirmAction("关闭将丢弃尚未保存的会话规则，是否继续？"))
  ) {
    rulesDirty.value = false;
    done();
  }
}
async function closeRename(done: () => void) {
  if (!draftDirty.value || (await confirmAction("放弃尚未保存的名称修改？")))
    done();
}
function onScroll() {
  const el = viewport.value;
  if (el)
    following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
async function bottom() {
  following.value = true;
  await nextTick();
  const el = viewport.value;
  if (el) el.scrollTop = el.scrollHeight;
}
async function older() {
  const el = viewport.value;
  if (!el) return;
  const height = el.scrollHeight;
  const top = el.scrollTop;
  following.value = false;
  await chat.action(() => chat.loadMessages(true));
  await nextTick();
  el.scrollTop = top + el.scrollHeight - height;
}
function keydown(event: Event | KeyboardEvent) {
  if (!(event instanceof KeyboardEvent)) return;
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault();
    if (!chat.busy && !chat.active && !chat.runtime) {
      void chat.send();
      void bottom();
    }
  }
}
watch(
  () => route.params.id,
  async (id) => {
    if (!route.path.startsWith("/chat")) return;
    const value = typeof id === "string" ? id : "";
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
    <aside
      class="conversation-sidebar"
      :class="{ 'is-open': mobileList }"
      aria-label="会话列表"
    >
      <div class="conversation-actions">
        <el-button
          type="primary"
          :icon="Plus"
          :disabled="chat.busy"
          @click="create"
          >新建对话</el-button
        ><el-button class="close-conversations" text @click="mobileList = false"
          >收起</el-button
        >
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
        <el-empty
          v-if="!filtered.length"
          :image-size="48"
          description="暂无匹配会话"
        /><button
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
          <strong>{{ chat.title || "开始一段新对话" }}</strong
          ><small>全局默认模型：{{ session.modelLabel }}</small>
        </div>
        <el-dropdown v-if="chat.selected" trigger="click" @command="command"
          ><el-button :icon="MoreFilled" aria-label="会话菜单" /><template
            #dropdown
            ><el-dropdown-menu
              ><el-dropdown-item command="rename">重命名</el-dropdown-item
              ><el-dropdown-item command="details"
                >会话详情与规则</el-dropdown-item
              ><el-dropdown-item
                command="remove"
                :disabled="chat.active"
                divided
                >删除对话</el-dropdown-item
              ></el-dropdown-menu
            ></template
          ></el-dropdown
        >
      </header>
      <el-alert
        v-if="chat.notice"
        :title="chat.notice"
        type="error"
        show-icon
        :closable="false"
        ><el-button text @click="chat.select(chat.selected)"
          >重新加载会话</el-button
        ></el-alert
      >
      <div ref="viewport" class="message-viewport" @scroll="onScroll">
        <div class="message-column">
          <el-skeleton v-if="chat.loading" :rows="5" animated />
          <div
            v-else-if="!chat.selected || !chat.messages.length"
            class="chat-welcome"
          >
            <span class="brand-mark">M</span>
            <h1>今天有什么想一起完成？</h1>
            <p>整理思路、处理工作目录文件，或聊聊你的计划。</p>
            <el-alert
              v-if="session.modelLabel === '尚未指定'"
              title="先配置一个默认模型，即可开始对话"
              type="info"
              :closable="false"
              ><RouterLink to="/settings/models"
                >前往模型设置 →</RouterLink
              ></el-alert
            ><el-button v-if="!chat.selected" type="primary" @click="create"
              >创建新对话</el-button
            >
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
          <el-button
            v-if="chat.nextCursor"
            text
            :loading="chat.busy"
            @click="older"
            >加载更早消息</el-button
          >
          <article
            v-for="message in chat.visibleMessages"
            :key="message.id"
            class="chat-message"
            :class="{ 'from-user': message.role === 'user' }"
          >
            <div class="message-meta">
              <strong>{{
                message.role === "user" ? "你" : session.assistantLabel
              }}</strong
              ><el-button
                text
                size="small"
                aria-label="复制消息"
                @click="copy(message.content)"
                >复制</el-button
              >
            </div>
            <div
              class="markdown"
              v-html="renderMarkdown(message.content)"
            ></div>
          </article>
          <article v-if="chat.active && chat.liveText" class="chat-message">
            <strong>{{ session.assistantLabel }}</strong>
            <div class="markdown" v-html="renderMarkdown(chat.liveText)"></div>
          </article>
          <div v-if="chat.task" class="task-process" aria-label="本次执行">
            <el-tag
              :type="
                chat.task.status === 'failed'
                  ? 'danger'
                  : chat.active
                    ? 'warning'
                    : 'info'
              "
              >{{ statusLabel(chat.task.status) }}</el-tag
            >
            <p v-if="chat.task.error" role="alert">{{ chat.task.error }}</p>
            <el-collapse
              v-if="chat.task.tools?.length || chat.task.skills?.length"
              ><el-collapse-item
                :title="`执行过程 · ${chat.task.tools?.length ?? 0} 项工具操作`"
                name="process"
                ><p v-for="(skill, index) in chat.task.skills" :key="index">
                  已加载 {{ skill.name }} · 版本 {{ skill.version }} ·
                  {{ skill.resource ?? "技能说明" }} · {{ skill.loadedAt }}
                </p>
                <div v-for="tool in chat.task.tools" :key="tool.id">
                  <strong
                    >{{ tool.name }} · {{ statusLabel(tool.status) }}</strong
                  >
                  <pre>{{ tool.arguments }}</pre>
                  <pre v-if="tool.result">{{ tool.result }}</pre>
                </div>
                <p v-if="chat.task.model_snapshot">
                  实际模型：{{ modelLabel(chat.task.model_snapshot) }}
                </p></el-collapse-item
              ></el-collapse
            >
            <article
              v-for="tool in (chat.task.tools ?? []).filter(
                (item) => item.status === 'pending',
              )"
              :key="tool.id"
              class="approval-card"
              aria-label="待确认操作"
            >
              <h3>需要你的确认</h3>
              <p>即将执行 {{ tool.name }}。请核对以下完整参数：</p>
              <pre>{{ tool.arguments }}</pre>
              <el-button
                type="primary"
                :disabled="chat.busy || !chat.active"
                @click="chat.decide(tool, true)"
                >允许本次操作</el-button
              ><el-button
                :disabled="chat.busy || !chat.active"
                @click="chat.decide(tool, false)"
                >拒绝</el-button
              >
            </article>
            <el-button
              v-if="
                chat.task.kind !== 'summary' &&
                ['failed', 'cancelled', 'interrupted'].includes(
                  chat.task.status,
                )
              "
              :disabled="chat.busy || !!chat.runtime"
              @click="chat.send(chat.task!.input, true)"
              >以新任务重试</el-button
            >
          </div>
          <el-alert
            v-if="chat.connection"
            :title="chat.connection"
            type="warning"
            :closable="false"
            ><el-button text @click="chat.select(chat.selected)"
              >重新连接</el-button
            ></el-alert
          >
          <p v-if="chat.contextNotice" role="status">
            {{ chat.contextNotice }}
          </p>
        </div>
      </div>
      <footer v-if="chat.selected" class="composer">
        <el-button
          v-if="!following"
          class="back-latest"
          size="small"
          @click="bottom"
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
            ><span class="header-spacer" /><el-button
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
                session.modelLabel === '尚未指定'
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
    <el-dialog
      v-model="renameOpen"
      title="重命名对话"
      width="440px"
      :before-close="closeRename"
      ><el-form @submit.prevent="rename"
        ><el-input
          v-model="newTitle"
          aria-label="对话名称"
          maxlength="100"
          required
        />
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
