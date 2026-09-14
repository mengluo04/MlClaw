import { computed, ref, reactive } from 'vue';
import { defineStore } from 'pinia';
import type {
  Conversation,
  DefaultModel,
  Message,
  Task,
  TaskEvent,
  ToolRecord,
} from '@mlclaw/shared';
import { api, ApiError, ApiTimeoutError } from '../api';
import { createUuid } from '../uuid';
import { useSession } from './session';

/** 将任务状态转换为中文展示文案。 */
export const statusLabel = (status: string) =>
  ({
    queued: '等待执行',
    running: '正在执行',
    waiting_approval: '等待你的确认',
    succeeded: '已完成',
    failed: '执行失败',
    cancelled: '已停止',
    interrupted: '已中断',
    pending: '等待确认',
    approved: '已批准',
    rejected: '已拒绝',
  })[status] ?? status;
/** 共享聊天状态的 Store 入口。 */
export const useChat = defineStore('chat', () => {
  /** 当前用户的登录与助手状态。 */
  const session = useSession();
  /** 当前会话列表。 */
  const conversations = ref<Conversation[]>([]);
  /** 会话列表搜索关键词。 */
  const listQuery = ref('');
  /** 会话列表的分页游标。 */
  const listCursor = ref<string | null>(null);
  /** 会话列表加载状态。 */
  const listLoading = ref(false);
  /** 会话列表请求序号，用于丢弃过期响应。 */
  let listRequest = 0;
  /** 未读记录数量。 */
  const unread = ref(0);
  /** 当前选中的会话标识。 */
  const selected = ref('');
  /** 临时模型选择，仅保存在内存，切换会话时清空。 */
  const modelChoice = ref<DefaultModel>();
  /** 当前记录标题。 */
  const title = ref('');
  /** 当前会话的消息列表。 */
  const messages = ref<Message[]>([]);
  /** 下一页数据的游标。 */
  const nextCursor = ref<string | null>(null);
  /** 当前任务记录。 */
  const task = ref<Task | null>(null);
  /** 正在接收的助手增量文本。 */
  const liveText = ref('');
  /** 流式助手消息标识。 */
  const liveId = ref('');
  /** 当前操作反馈文案。 */
  const notice = ref('');
  /** 当前实时连接状态。 */
  const connection = ref('');
  /** 会话上下文变化的提示文案。 */
  const contextNotice = ref('');
  /** 操作进行中标记，用于禁用重复提交。 */
  const busy = ref(false);
  /** 数据加载状态。 */
  const loading = ref(false);
  /** 按会话保存的未发送草稿。 */
  const drafts = reactive<Record<string, string>>({});
  /** 是否存在尚未发送的草稿。 */
  const hasDrafts = computed(() => Object.values(drafts).some((value) => value.trim()));
  /** 存在未保存内容时触发浏览器离开提示。 */
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (hasDrafts.value) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  /** 当前输入内容。 */
  const input = computed({
    get: () => drafts[selected.value] ?? '',
    set: (value) => {
      drafts[selected.value] = value;
    },
  });
  /** 是否存在活动中的任务或对象。 */
  const active = computed(
    () => !!task.value && ['queued', 'running', 'waiting_approval'].includes(task.value.status),
  );
  /** 排除正在流式展示项后的消息列表。 */
  const visibleMessages = computed(() =>
    messages.value.filter((message) => !active.value || message.id !== liveId.value),
  );
  /** 当前活动任务的运行信息。 */
  const runtime = ref<{
    id: string;
    conversationId: string;
    status: string;
    kind: string;
  } | null>(null);
  /** 按会话缓存待发送内容与幂等键，重试复用同一请求。 */
  const pending = new Map<
    string,
    { content: string; idempotencyKey: string; modelChoice?: DefaultModel }
  >();
  /** 当前会话任务的 SSE 连接，切换会话时关闭。 */
  let source: EventSource | undefined;
  /** 最近处理的事件标识，用于续传或去重。 */
  let lastId = 0;
  /** 当前订阅代次，用于识别过期回调。 */
  let generation = 0;
  /** 详情请求序号，用于丢弃过期响应。 */
  let detailRequest = 0;
  /** 消息请求序号，用于丢弃过期响应。 */
  let messageRequest = 0;
  /** 延迟执行或超时控制的定时器句柄。 */
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 是否已有轮询请求正在进行。 */
  let polling = false;
  /** 当前登录代次，避免旧会话请求污染新状态。 */
  let sessionEpoch = 0;
  /** 活动任务请求序号，用于丢弃过期响应。 */
  let runtimeRequest = 0;
  /** 关闭当前 SSE 连接并清除引用。 */
  const stopEvents = () => {
    source?.close();
    source = undefined;
  };
  /** 将异常转换为当前流程的失败状态或用户反馈。 */
  const fail = (cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) session.clear();
    notice.value = cause instanceof Error ? cause.message : '操作失败，请重试';
  };
  /** 统一处理操作期间的忙碌状态与错误反馈。 */
  const action = async (operation: () => Promise<void>) => {
    if (busy.value) return;
    busy.value = true;
    notice.value = '';
    try {
      await operation();
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
      fail(cause);
    } finally {
      busy.value = false;
    }
  };
  /** 加载当前页面或业务所需的数据。 */
  const load = async (older = false) => {
    /** 当前请求或本次加载的标识。 */
    const request = ++listRequest;
    listLoading.value = true;
    /** 当前请求参数。 */
    const params = new URLSearchParams({ q: listQuery.value });
    if (older && listCursor.value) params.set('before', listCursor.value);
    try {
      /** 接口 /conversations/page?${params} 返回的业务数据。 */
      const result = await api<{
        items: Conversation[];
        nextCursor: string | null;
      }>(`/conversations/page?${params}`);
      if (request === listRequest) {
        conversations.value = older ? [...conversations.value, ...result.items] : result.items;
        listCursor.value = result.nextCursor;
      }
    } finally {
      if (request === listRequest) listLoading.value = false;
    }
  };
  /** 分页加载当前会话消息并防止旧响应覆盖新状态。 */
  const loadMessages = async (older = false) => {
    /** 当前请求或本次加载的标识。 */
    const request = ++messageRequest;
    /** 本次异步操作捕获的会话或任务标识。 */
    const id = selected.value;
    /** 本次请求捕获的代次，用于忽略过期响应。 */
    const epoch = generation;
    if (!id) return;
    /** 当前会话返回的消息页与下一页游标。 */
    const result = await api<{
      messages: Message[];
      nextCursor: string | null;
    }>(
      `/conversations/${id}/messages${older && nextCursor.value ? `?before=${nextCursor.value}` : ''}`,
    );
    if (request !== messageRequest || selected.value !== id || epoch !== generation) return;
    /** 加载前是否没有消息，用于决定初始展示行为。 */
    const wasEmpty = messages.value.length === 0;
    /** 本次返回的消息标识集合，用于合并去重。 */
    const incoming = new Set(result.messages.map((message) => message.id));
    /** 与本次返回数据不重复的已有消息。 */
    const retained = messages.value.filter((message) => !incoming.has(message.id));
    messages.value = older ? [...result.messages, ...retained] : [...retained, ...result.messages];
    if (older || wasEmpty) nextCursor.value = result.nextCursor;
  };
  /** 读取指定任务的最新状态与工具记录。 */
  const refreshTask = async (id: string) => {
    /** 本次请求捕获的代次，用于忽略过期响应。 */
    const epoch = generation;
    /** 当前请求或本次加载的标识。 */
    const request = ++detailRequest;
    /** 接口 /tasks/${id} 返回的业务数据。 */
    const result = await api<Task>(`/tasks/${id}`);
    if (epoch === generation && task.value?.id === id && request === detailRequest)
      task.value = result;
  };
  /** 订阅事件并处理重连与状态同步。 */
  const subscribe = (id: string) => {
    stopEvents();
    lastId = 0;
    liveId.value = '';
    liveText.value = '';
    connection.value = '正在连接实时输出…';
    /** 本次请求捕获的代次，用于忽略过期响应。 */
    const epoch = generation;
    /** 本次任务新建的 SSE 连接。 */
    const stream = new EventSource(`/api/tasks/${id}/events`);
    source = stream;
    /** 读取当前有效记录。 */
    const current = () => epoch === generation && source === stream && task.value?.id === id;
    stream.onopen = () => {
      if (current()) connection.value = '';
    };
    const receive = (event: MessageEvent, snapshot = false) => {
      if (!current()) return;
      /** 当前处理的值。 */
      let value: TaskEvent;
      try {
        value = JSON.parse(event.data) as TaskEvent;
        if (!Number.isSafeInteger(value.id) || typeof value.type !== 'string' || !value.data)
          throw new Error();
      } catch {
        connection.value = '实时数据异常，请重新连接';
        stopEvents();
        return;
      }
      if (value.taskId !== id || (!snapshot && value.id <= lastId)) return;
      lastId = value.id;
      if (value.type === 'message.delta' || value.type === 'message.snapshot' || snapshot) {
        /** 本次消息的唯一标识。 */
        const messageId = value.data.messageId ?? '';
        if (messageId !== liveId.value) {
          if (liveId.value) void loadMessages().catch(fail);
          liveId.value = messageId;
          liveText.value = '';
        }
        if (value.type === 'message.delta') liveText.value += value.data.text ?? '';
        else liveText.value = value.data.text ?? '';
      }
      if (value.type.startsWith('summary.') || value.type === 'context.omitted')
        contextNotice.value = value.data.message ?? '';
      if (value.data.status && task.value) {
        ++detailRequest;
        task.value.status = value.data.status;
      }
      if (value.type.startsWith('tool.') || value.type === 'skill.loaded')
        void refreshTask(id).catch(fail);
      if (
        ['task.finished', 'task.failed', 'task.cancelled'].includes(value.type) ||
        (snapshot &&
          value.data.status &&
          !['queued', 'running', 'waiting_approval'].includes(value.data.status))
      ) {
        stopEvents();
        connection.value = '';
        void Promise.all([
          refreshTask(id),
          loadMessages(),
          refreshRuntime(),
          session.refreshConfig(),
        ]).catch(fail);
      }
    };
    stream.onmessage = (event) => receive(event);
    stream.addEventListener('snapshot', (event) => receive(event as MessageEvent, true));
    stream.onerror = () => {
      if (!current()) return;
      connection.value = '连接中断，正在恢复；不会重新提交任务';
      void api<Task>(`/tasks/${id}`)
        .then(async (result) => {
          if (!current()) return;
          if (!['queued', 'running', 'waiting_approval'].includes(result.status)) {
            task.value = result;
            stopEvents();
            connection.value = '';
            await loadMessages();
          }
        })
        .catch(fail);
    };
  };
  /** 切换当前选中的记录。 */
  const select = async (id: string) => {
    /** 本次请求捕获的代次，用于忽略过期响应。 */
    const epoch = ++generation;
    stopEvents();
    if (selected.value !== id) modelChoice.value = undefined;
    selected.value = id;
    title.value = '';
    task.value = null;
    messages.value = [];
    nextCursor.value = null;
    liveText.value = '';
    liveId.value = '';
    contextNotice.value = '';
    connection.value = '';
    notice.value = '';
    if (!id) {
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      /** 当前详情数据。 */
      const detail = await api<Conversation & { latestTask: Task | null }>(`/conversations/${id}`);
      /** 所选会话最近一次任务的完整状态。 */
      const latest = detail.latestTask ? await api<Task>(`/tasks/${detail.latestTask.id}`) : null;
      if (epoch !== generation) return;
      title.value = detail.title;
      task.value = latest;
      await loadMessages();
      if (epoch === generation && active.value && task.value) subscribe(task.value.id);
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
      if (epoch === generation) fail(cause);
    } finally {
      if (epoch === generation) loading.value = false;
    }
  };
  /** 创建一条新记录并同步当前状态。 */
  const create = async () => {
    /** 接口 /conversations 返回的业务数据。 */
    const result = await api<Conversation>('/conversations', 'POST', {
      title: '新对话',
    });
    await load();
    return result.id;
  };
  /** 发送当前内容并处理返回结果。 */
  const send = async (content = input.value, retry = false) => {
    /** 本次请求捕获的代次，用于忽略过期响应。 */
    const epoch = sessionEpoch;
    /** 本次异步操作捕获的会话或任务标识。 */
    const id = selected.value;
    if (!id || !content.trim() || active.value || loading.value) return;
    await action(async () => {
      if (retry || !pending.has(id) || pending.get(id)!.content !== content)
        pending.set(id, {
          content,
          idempotencyKey: createUuid(),
          modelChoice: modelChoice.value ? { ...modelChoice.value } : undefined,
        });
      /** 接口 /conversations/${id}/messages 返回的业务数据。 */
      const result = await api<{ taskId: string }>(
        `/conversations/${id}/messages`,
        'POST',
        pending.get(id),
      ).catch((cause: unknown) => {
        // 明确拒绝的请求未创建任务，允许修正模型后重新发送；网络异常保留原请求。
        if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500)
          pending.delete(id);
        throw cause;
      });
      if (epoch !== sessionEpoch) return;
      pending.delete(id);
      if (drafts[id] === content) drafts[id] = '';
      /** 发送消息后读取的最新任务状态。 */
      const resultTask = await api<Task>(`/tasks/${result.taskId}`);
      if (epoch !== sessionEpoch) return;
      if (selected.value === id) {
        task.value = resultTask;
        await loadMessages();
        subscribe(result.taskId);
      }
      await refreshRuntime();
    });
  };
  /** 取消当前执行并更新相关状态。 */
  const cancel = async () => {
    await action(async () => {
      if (task.value) await api(`/tasks/${task.value.id}/cancel`, 'POST');
    });
  };
  /** 同步全局活动任务状态。 */
  const refreshRuntime = async () => {
    /** 本次请求捕获的代次，用于忽略过期响应。 */
    const epoch = sessionEpoch;
    /** 当前请求或本次加载的标识。 */
    const request = ++runtimeRequest;
    /** 本次请求捕获的用户名，用于识别登录状态变化。 */
    const user = session.user;
    /** result：本次处理结果；reminders：本次刷新返回的未读定时提醒统计。 */
    const [result, reminders] = await Promise.all([
      api<{ activeTask: typeof runtime.value }>('/runtime-status'),
      api<{ unread: number }>('/reminders/unread'),
    ]);
    if (epoch === sessionEpoch && request === runtimeRequest && user && user === session.user) {
      runtime.value = result.activeTask;
      unread.value = reminders.unread;
    }
  };
  /** 启动当前服务或状态订阅。 */
  const start = () => {
    if (polling) return;
    window.addEventListener('beforeunload', beforeUnload);
    polling = true;
    /** 本次请求捕获的代次，用于忽略过期响应。 */
    const epoch = sessionEpoch;
    /** 轮询上游状态并处理取消。 */
    const poll = async () => {
      if (!polling || epoch !== sessionEpoch || !session.user) return;
      try {
        await refreshRuntime();
      } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
        if (!polling || epoch !== sessionEpoch) return;
        // 后台轮询超时由下一轮自动恢复，不干扰正在执行的对话。
        if (!(cause instanceof ApiTimeoutError)) fail(cause);
      }
      if (polling && epoch === sessionEpoch) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
  };
  /** 清理当前状态以便重新初始化。 */
  const reset = () => {
    window.removeEventListener('beforeunload', beforeUnload);
    ++sessionEpoch;
    ++runtimeRequest;
    busy.value = false;
    loading.value = false;
    listLoading.value = false;
    title.value = '';
    nextCursor.value = null;
    liveId.value = '';
    liveText.value = '';
    notice.value = '';
    connection.value = '';
    contextNotice.value = '';
    ++generation;
    ++listRequest;
    unread.value = 0;
    listCursor.value = null;
    listQuery.value = '';
    polling = false;
    clearTimeout(timer);
    stopEvents();
    conversations.value = [];
    selected.value = '';
    modelChoice.value = undefined;
    messages.value = [];
    task.value = null;
    runtime.value = null;
    pending.clear();
    for (/* 逐项处理当前索引或字段键。 */ const key of Object.keys(drafts)) delete drafts[key];
  };
  return {
    modelChoice,
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
    subscribe,
    refreshTask,
    start,
    reset,
  };
});
