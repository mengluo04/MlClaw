import { computed, ref, reactive } from "vue";
import { defineStore } from "pinia";
import type {
  Conversation,
  Message,
  Task,
  TaskEvent,
  ToolRecord,
} from "@mlclaw/shared";
import { api, ApiError } from "../api";
import { useSession } from "./session";

export const statusLabel = (status: string) =>
  ({
    queued: "等待执行",
    running: "正在执行",
    waiting_approval: "等待你的确认",
    succeeded: "已完成",
    failed: "执行失败",
    cancelled: "已停止",
    interrupted: "已中断",
    pending: "等待确认",
    approved: "已批准",
    rejected: "已拒绝",
  })[status] ?? status;
export const useChat = defineStore("chat", () => {
  const session = useSession();
  const conversations = ref<Conversation[]>([]);
  const listQuery = ref("");
  const listCursor = ref<string | null>(null);
  const listLoading = ref(false);
  let listRequest = 0;
  const unread = ref(0);
  const selected = ref("");
  const title = ref("");
  const messages = ref<Message[]>([]);
  const nextCursor = ref<string | null>(null);
  const task = ref<Task | null>(null);
  const liveText = ref("");
  const liveId = ref("");
  const notice = ref("");
  const connection = ref("");
  const contextNotice = ref("");
  const busy = ref(false);
  const loading = ref(false);
  const drafts = reactive<Record<string, string>>({});
  const hasDrafts = computed(() =>
    Object.values(drafts).some((value) => value.trim()),
  );
  function beforeUnload(event: BeforeUnloadEvent) {
    if (hasDrafts.value) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  const input = computed({
    get: () => drafts[selected.value] ?? "",
    set: (value) => {
      drafts[selected.value] = value;
    },
  });
  const active = computed(
    () =>
      !!task.value &&
      ["queued", "running", "waiting_approval"].includes(task.value.status),
  );
  const visibleMessages = computed(() =>
    messages.value.filter(
      (message) => !active.value || message.id !== liveId.value,
    ),
  );
  const runtime = ref<{
    id: string;
    conversationId: string;
    status: string;
    kind: string;
  } | null>(null);
  const pending = new Map<
    string,
    { content: string; idempotencyKey: string }
  >();
  let source: EventSource | undefined;
  let lastId = 0;
  let generation = 0;
  let detailRequest = 0;
  let messageRequest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let sessionEpoch = 0;
  let runtimeRequest = 0;
  function stopEvents() {
    source?.close();
    source = undefined;
  }
  function fail(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) session.clear();
    notice.value = cause instanceof Error ? cause.message : "操作失败，请重试";
  }
  async function action(operation: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true;
    notice.value = "";
    try {
      await operation();
    } catch (cause) {
      fail(cause);
    } finally {
      busy.value = false;
    }
  }
  async function load(older = false) {
    const request = ++listRequest;
    listLoading.value = true;
    const params = new URLSearchParams({ q: listQuery.value });
    if (older && listCursor.value) params.set("before", listCursor.value);
    try {
      const result = await api<{
        items: Conversation[];
        nextCursor: string | null;
      }>(`/conversations/page?${params}`);
      if (request === listRequest) {
        conversations.value = older
          ? [...conversations.value, ...result.items]
          : result.items;
        listCursor.value = result.nextCursor;
      }
    } finally {
      if (request === listRequest) listLoading.value = false;
    }
  }
  async function loadMessages(older = false) {
    const request = ++messageRequest;
    const id = selected.value;
    const epoch = generation;
    if (!id) return;
    const result = await api<{
      messages: Message[];
      nextCursor: string | null;
    }>(
      `/conversations/${id}/messages${older && nextCursor.value ? `?before=${nextCursor.value}` : ""}`,
    );
    if (
      request !== messageRequest ||
      selected.value !== id ||
      epoch !== generation
    )
      return;
    const wasEmpty = messages.value.length === 0;
    const incoming = new Set(result.messages.map((message) => message.id));
    const retained = messages.value.filter(
      (message) => !incoming.has(message.id),
    );
    messages.value = older
      ? [...result.messages, ...retained]
      : [...retained, ...result.messages];
    if (older || wasEmpty) nextCursor.value = result.nextCursor;
  }
  async function refreshTask(id: string) {
    const epoch = generation;
    const request = ++detailRequest;
    const result = await api<Task>(`/tasks/${id}`);
    if (
      epoch === generation &&
      task.value?.id === id &&
      request === detailRequest
    )
      task.value = result;
  }
  function subscribe(id: string) {
    stopEvents();
    lastId = 0;
    liveId.value = "";
    liveText.value = "";
    connection.value = "正在连接实时输出…";
    const epoch = generation;
    const stream = new EventSource(`/api/tasks/${id}/events`);
    source = stream;
    const current = () =>
      epoch === generation && source === stream && task.value?.id === id;
    stream.onopen = () => {
      if (current()) connection.value = "";
    };
    stream.onmessage = (event) => {
      if (!current()) return;
      let value: TaskEvent;
      try {
        value = JSON.parse(event.data) as TaskEvent;
        if (
          !Number.isSafeInteger(value.id) ||
          typeof value.type !== "string" ||
          !value.data
        )
          throw new Error();
      } catch {
        connection.value = "实时数据异常，请重新连接";
        stopEvents();
        return;
      }
      if (value.taskId !== id || value.id <= lastId) return;
      lastId = value.id;
      if (value.type === "message.delta") {
        const messageId = value.data.messageId ?? "";
        if (messageId !== liveId.value) {
          if (liveId.value) void loadMessages().catch(fail);
          liveId.value = messageId;
          liveText.value = "";
        }
        liveText.value += value.data.text ?? "";
      }
      if (value.type.startsWith("summary.") || value.type === "context.omitted")
        contextNotice.value = value.data.message ?? "";
      if (value.data.status && task.value) {
        ++detailRequest;
        task.value.status = value.data.status;
      }
      if (value.type.startsWith("tool.") || value.type === "skill.loaded")
        void refreshTask(id).catch(fail);
      if (
        ["task.finished", "task.failed", "task.cancelled"].includes(value.type)
      ) {
        stopEvents();
        connection.value = "";
        void Promise.all([
          refreshTask(id),
          loadMessages(),
          refreshRuntime(),
        ]).catch(fail);
      }
    };
    stream.onerror = () => {
      if (!current()) return;
      connection.value = "连接中断，正在恢复；不会重新提交任务";
      void api<Task>(`/tasks/${id}`)
        .then(async (result) => {
          if (!current()) return;
          if (
            !["queued", "running", "waiting_approval"].includes(result.status)
          ) {
            task.value = result;
            stopEvents();
            connection.value = "";
            await loadMessages();
          }
        })
        .catch(fail);
    };
  }
  async function select(id: string) {
    const epoch = ++generation;
    stopEvents();
    selected.value = id;
    title.value = "";
    task.value = null;
    messages.value = [];
    nextCursor.value = null;
    liveText.value = "";
    liveId.value = "";
    contextNotice.value = "";
    connection.value = "";
    notice.value = "";
    if (!id) {
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const detail = await api<Conversation & { latestTask: Task | null }>(
        `/conversations/${id}`,
      );
      const latest = detail.latestTask
        ? await api<Task>(`/tasks/${detail.latestTask.id}`)
        : null;
      if (epoch !== generation) return;
      title.value = detail.title;
      task.value = latest;
      await loadMessages();
      if (epoch === generation && active.value && task.value)
        subscribe(task.value.id);
    } catch (cause) {
      if (epoch === generation) fail(cause);
    } finally {
      if (epoch === generation) loading.value = false;
    }
  }
  async function create() {
    const result = await api<Conversation>("/conversations", "POST", {
      title: "新对话",
    });
    await load();
    return result.id;
  }
  async function send(content = input.value, retry = false) {
    const epoch = sessionEpoch;
    const id = selected.value;
    if (!id || !content.trim() || active.value || loading.value) return;
    await action(async () => {
      if (retry || !pending.has(id) || pending.get(id)!.content !== content)
        pending.set(id, { content, idempotencyKey: crypto.randomUUID() });
      const result = await api<{ taskId: string }>(
        `/conversations/${id}/messages`,
        "POST",
        pending.get(id),
      );
      if (epoch !== sessionEpoch) return;
      pending.delete(id);
      if (drafts[id] === content) drafts[id] = "";
      const resultTask = await api<Task>(`/tasks/${result.taskId}`);
      if (epoch !== sessionEpoch) return;
      if (selected.value === id) {
        task.value = resultTask;
        await loadMessages();
        subscribe(result.taskId);
      }
      await refreshRuntime();
    });
  }
  async function cancel() {
    await action(async () => {
      if (task.value) await api(`/tasks/${task.value.id}/cancel`, "POST");
    });
  }
  async function decide(tool: ToolRecord, approved: boolean) {
    const id = task.value?.id;
    await action(async () => {
      try {
        await api(`/tool-calls/${tool.id}/decision`, "POST", {
          approved,
          argumentsDigest: tool.arguments_digest,
        });
      } finally {
        if (id) await refreshTask(id);
      }
    });
  }
  async function refreshRuntime() {
    const epoch = sessionEpoch;
    const request = ++runtimeRequest;
    const user = session.user;
    const [result, reminders] = await Promise.all([
      api<{ activeTask: typeof runtime.value }>("/runtime-status"),
      api<{ unread: number }>("/reminders/unread"),
    ]);
    if (
      epoch === sessionEpoch &&
      request === runtimeRequest &&
      user &&
      user === session.user
    ) {
      runtime.value = result.activeTask;
      unread.value = reminders.unread;
    }
  }
  function start() {
    if (polling) return;
    window.addEventListener("beforeunload", beforeUnload);
    polling = true;
    const epoch = sessionEpoch;
    const poll = async () => {
      if (!polling || epoch !== sessionEpoch || !session.user) return;
      try {
        await refreshRuntime();
      } catch (cause) {
        fail(cause);
      }
      if (polling && epoch === sessionEpoch)
        timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
  }
  function reset() {
    window.removeEventListener("beforeunload", beforeUnload);
    ++sessionEpoch;
    ++runtimeRequest;
    busy.value = false;
    loading.value = false;
    listLoading.value = false;
    title.value = "";
    nextCursor.value = null;
    liveId.value = "";
    liveText.value = "";
    notice.value = "";
    connection.value = "";
    contextNotice.value = "";
    ++generation;
    ++listRequest;
    unread.value = 0;
    listCursor.value = null;
    listQuery.value = "";
    polling = false;
    clearTimeout(timer);
    stopEvents();
    conversations.value = [];
    selected.value = "";
    messages.value = [];
    task.value = null;
    runtime.value = null;
    pending.clear();
    for (const key of Object.keys(drafts)) delete drafts[key];
  }
  return {
    hasDrafts,
    conversations,
    listQuery,
    listCursor,
    listLoading,
    unread,
    selected,
    title,
    messages,
    nextCursor,
    task,
    liveText,
    liveId,
    notice,
    connection,
    contextNotice,
    busy,
    loading,
    input,
    active,
    visibleMessages,
    runtime,
    action,
    load,
    loadMessages,
    select,
    create,
    send,
    cancel,
    decide,
    subscribe,
    refreshTask,
    start,
    reset,
  };
});
