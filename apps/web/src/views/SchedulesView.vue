<script setup lang="ts">
import { useSession } from '../stores/session';
import { useRoute, useRouter } from 'vue-router';
import { useDirtyGuard } from '../composables/dirty';
import { confirmAction } from '../composables/confirm';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
  ChannelSettings,
  Schedule,
  ScheduleBatchOperation,
  ScheduleBatchResult,
  ScheduleHistory,
  ScheduleInput,
  ScheduleList,
  SchedulePreview,
} from '@mlclaw/shared';
import { api, ApiError } from '../api';
import { createUuid } from '../uuid';

/** 当前用户的登录与助手状态。 */
const session = useSession();
/** 前端路由实例。 */
const router = useRouter();
/** 当前功能设置。 */
const settings = ref<ScheduleList>({
  schedules: [],
  timezone: '',
  schedulerError: null,
  unread: 0,
});
/** 当前读取的历史消息或执行记录。 */
const history = ref<ScheduleHistory>({ occurrences: [], nextCursor: null });
/** 当前渠道集合或管理器。 */
const channels = ref<ChannelSettings['accounts']>([]);
/** 将业务类型转换为中文标签。 */
const kindLabel = (kind: string) =>
  kind === 'command' ? '脚本任务' : kind === 'agent' ? '只读 AI' : '旧固定提醒（已停用）';
/** 投递状态对应的中文标签。 */
const deliveryLabels: Record<string, string> = {
  pending: '等待投递',
  sending: '发送中',
  sent: '平台已确认发送',
  failed: '发送失败',
  unknown: '发送结果未确认',
  cancelled: '未投递',
};
/** 将渠道标识转换为页面展示名称。 */
const channelName = (id: string | null | undefined) => {
  if (!id) return '仅站内';
  /** 当前渠道对象。 */
  const channel = channels.value.find((item) => item.id === id);
  return channel?.displayName ?? '渠道已移除';
};
/** 是否已完成首次数据加载。 */
const loaded = ref(false);
/** 操作进行中标记，用于禁用重复提交。 */
const busy = ref(false);
/** 当前错误提示。 */
const error = ref('');
/** 当前操作反馈文案。 */
const notice = ref('');
/** 当前路由信息。 */
const route = useRoute();
/** 编辑器是否打开。 */
const editorOpen = ref(false);
/** 当前选中的页签。 */
const tab = ref(route.query.tab === 'history' ? 'history' : 'plans');
watch(
  () => route.query.tab,
  (value) => {
    if (value === 'history') tab.value = 'history';
  },
);
/** 当前正在编辑的记录。 */
const editing = ref<Schedule | null>(null);
/** 检查并取得仍然有效的运行数据。 */
const fresh = (): ScheduleInput => ({
  name: '',
  kind: 'agent',
  content: '',
  cron: '0 9 * * *',
  enabled: true,
  deliveryChannelId: null,
  commandOptions: { timeoutMs: 60000 },
});
/** 可编辑的当前草稿。 */
const draft = ref<ScheduleInput>(fresh());
/** 页面以秒表示的命令超时上限。 */
const commandTimeoutSeconds = computed({
  get: () => (draft.value.commandOptions?.timeoutMs ?? 60000) / 1000,
  set: (value: number) => {
    if (draft.value.commandOptions) draft.value.commandOptions.timeoutMs = Math.round(value * 1000);
  },
});
/** 已保存内容的序列化基线，用于判断未保存修改。 */
const baseline = ref(JSON.stringify(draft.value));
/** 当前草稿是否偏离已保存内容。 */
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value);
/** 页面选择的结果投递方式。 */
const deliveryChoice = computed({
  get: () => draft.value.deliveryChannelId ?? '',
  set: (value: string) => {
    draft.value.deliveryChannelId = value || null;
  },
});
/** 当前预览数据。 */
const preview = ref<SchedulePreview | null>(null);
/** 列表筛选条件。 */
const filter = ref('');
/** 是否只显示尚未阅读的记录。 */
const unreadOnly = ref(false);
/** 当前分页读取的起始游标。 */
const pageBefore = ref<number | null>(null);
/** 业务值到展示标签的映射。 */
const labels: Record<string, string> = {
  pending: '等待执行',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
  interrupted: '已中断',
};
/** 尚未结束的异步执行任务集合。 */
const pendingRuns = new Map<string, { idempotencyKey: string; expectedVersion: number }>();
/** 当前勾选的记录标识集合。 */
const selectedIds = ref<string[]>([]);
/** 当前批量操作选中的计划。 */
const selectedSchedules = computed(() =>
  settings.value.schedules.filter((schedule) => selectedIds.value.includes(schedule.id)),
);
/** 计划表格引用，用于同步勾选状态。 */
const scheduleTable = ref<{ clearSelection: () => void }>();
/** 组件是否仍挂载，防止卸载后的异步回调更新状态。 */
let alive = true;
/** 是否正在刷新数据。 */
let refreshing = false;
/** 正在进行的刷新任务，用于合并重复请求。 */
let refreshPromise: Promise<void> | undefined;
/** 延迟执行或超时控制的定时器句柄。 */
let timer: ReturnType<typeof setTimeout> | undefined;
/** 将异常转换为当前流程的失败状态或用户反馈。 */
const fail = (reason: unknown) => {
  if (!alive) return;
  if (reason instanceof ApiError && reason.status === 401) session.clear();
  error.value = reason instanceof Error ? reason.message : '定时任务操作失败，请重试';
};
/** 显示已有业务时间，空值使用占位文本。 */
const time = (value: string | null) => {
  return value ?? '—';
};
/** 加载当前页面或业务所需的数据。 */
const load = async () => {
  /** 当前检索条件。 */
  const query = new URLSearchParams();
  if (filter.value) query.set('scheduleId', filter.value);
  if (unreadOnly.value) query.set('unread', 'true');
  if (pageBefore.value) query.set('before', String(pageBefore.value));
  /** 本次请求捕获的筛选条件，避免旧查询结果覆盖新列表。 */
  const queryKey = query.toString();
  /** list：本次读取的业务列表；channelSettings：当前用户可用的渠道设置；records：本次读取的记录集合。 */
  const [list, channelSettings, records] = await Promise.all([
    api<ScheduleList>('/schedules'),
    api<ChannelSettings>('/channels'),
    api<ScheduleHistory>(`/schedule-occurrences?${queryKey}`),
  ]);
  if (!alive) return;
  settings.value = list;
  channels.value = channelSettings.accounts;
  /** 列表中当前仍然存在的记录标识集合。 */
  const existingIds = new Set(list.schedules.map((schedule) => schedule.id));
  selectedIds.value = selectedIds.value.filter((id) => existingIds.has(id));
  history.value = records;
  loaded.value = true;
};
/** 统一处理操作期间的忙碌状态与错误反馈。 */
const action = async (operation: () => Promise<void>) => {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await refreshPromise;
    if (!alive) return;
    await operation();
    await load();
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
};
/** 重新读取最新数据并同步当前状态。 */
const refresh = async () => {
  if (!alive) return;
  if (!busy.value && !refreshing) {
    refreshing = true;
    refreshPromise = load().catch(fail);
    try {
      await refreshPromise;
    } finally {
      refreshing = false;
      refreshPromise = undefined;
    }
  }
  if (alive)
    timer = setTimeout(() => {
      void refresh();
    }, 5000);
};
/** 加载所选记录进入编辑状态。 */
const edit = async (schedule: Schedule | null) => {
  if (dirty.value && !(await confirmAction('切换计划将丢弃未保存的草稿，是否继续？'))) return;
  try {
    channels.value = (await api<ChannelSettings>('/channels')).accounts;
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ cause) {
    fail(cause);
    return;
  }
  editorOpen.value = true;
  editing.value = schedule;
  draft.value = schedule
    ? {
        name: schedule.name,
        kind: schedule.kind,
        content: schedule.content,
        cron: schedule.cron,
        enabled: schedule.enabled,
        deliveryChannelId: schedule.deliveryChannelId ?? null,
        commandOptions: schedule.commandOptions ?? { timeoutMs: 60000 },
      }
    : fresh();
  baseline.value = JSON.stringify(draft.value);
  preview.value = null;
  notice.value = '';
};
/** 校验并保存当前编辑内容。 */
const save = async () => {
  await action(async () => {
    /** 已保存的记录或响应。 */
    const saved = await api<Schedule>(
      editing.value ? `/schedules/${editing.value.id}` : '/schedules',
      editing.value ? 'PUT' : 'POST',
      {
        ...draft.value,
        ...(editing.value ? { expectedVersion: editing.value.version } : {}),
      },
    );
    editing.value = saved;
    baseline.value = JSON.stringify(draft.value);
    notice.value = '定时计划已保存';
    editorOpen.value = false;
  });
};
/** 切换记录的启用状态。 */
const toggle = async (schedule: Schedule) => {
  await action(async () => {
    await api(`/schedules/${schedule.id}`, 'PUT', {
      name: schedule.name,
      kind: schedule.kind,
      content: schedule.content,
      cron: schedule.cron,
      enabled: !schedule.enabled,
      deliveryChannelId: schedule.deliveryChannelId ?? null,
      expectedVersion: schedule.version,
      commandOptions: schedule.commandOptions,
    });
    notice.value = schedule.enabled
      ? '计划已暂停，未启动的执行已取消；运行中的执行可单独取消'
      : '计划已启用';
  });
};
/** 同步表格批量选择结果。 */
const selectRows = (rows: Schedule[]) => {
  selectedIds.value = rows.map((row) => row.id);
};
/** 更新单个计划的勾选状态。 */
const selectOne = (id: string, selected: boolean) => {
  selectedIds.value = selected
    ? [...new Set([...selectedIds.value, id])]
    : selectedIds.value.filter((item) => item !== id);
};
/** 批量启停或删除所选计划并刷新列表。 */
const batchSchedules = async (operation: ScheduleBatchOperation) => {
  /** 当前计划集合或调度器。 */
  const schedules = selectedSchedules.value;
  if (!schedules.length) return;
  if (
    operation === 'delete' &&
    !(await confirmAction(
      `确定删除选中的 ${schedules.length} 个定时计划？未启动的执行将取消，已有历史和运行中的执行保留。`,
      '批量删除定时计划',
    ))
  )
    return;
  await action(async () => {
    /** 接口 /schedules/batch 返回的业务数据。 */
    const result = await api<ScheduleBatchResult>('/schedules/batch', 'POST', {
      operation,
      items: schedules.map((schedule) => ({
        id: schedule.id,
        expectedVersion: schedule.version,
      })),
    });
    if (operation === 'delete') {
      if (editing.value && selectedIds.value.includes(editing.value.id)) {
        baseline.value = JSON.stringify(draft.value);
        editorOpen.value = false;
        editing.value = null;
      }
      if (selectedIds.value.includes(filter.value)) filter.value = '';
    }
    scheduleTable.value?.clearSelection();
    selectedIds.value = [];
    /** 批量操作的中文展示名称。 */
    const actionLabel = operation === 'enable' ? '启用' : operation === 'disable' ? '禁用' : '删除';
    notice.value = `已批量${actionLabel} ${result.updated} 个定时计划`;
  });
};
/** 删除指定记录并更新当前列表。 */
const remove = async (schedule: Schedule) => {
  if (
    !(await confirmAction(
      '删除此计划将停止未来触发并取消未启动的执行；已有结果和运行中的执行保留。是否继续？',
    ))
  )
    return;
  await action(async () => {
    await api(`/schedules/${schedule.id}`, 'DELETE', {
      expectedVersion: schedule.version,
    });
    if (editing.value?.id === schedule.id) {
      baseline.value = JSON.stringify(draft.value);
      await edit(null);
      editorOpen.value = false;
    }
    if (filter.value === schedule.id) filter.value = '';
    notice.value = '定时计划已删除，执行历史保留';
  });
};
/** 执行当前操作并返回执行结果。 */
const run = async (schedule: Schedule) => {
  await action(async () => {
    /** 当前请求或本次加载的标识。 */
    const request = pendingRuns.get(schedule.id) ?? {
      idempotencyKey: createUuid(),
      expectedVersion: schedule.version,
    };
    pendingRuns.set(schedule.id, request);
    try {
      await api(`/schedules/${schedule.id}/run`, 'POST', request);
      pendingRuns.delete(schedule.id);
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ reason) {
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500)
        pendingRuns.delete(schedule.id);
      throw reason;
    }
    pageBefore.value = null;
    filter.value = schedule.id;
    unreadOnly.value = false;
    notice.value = '执行已登记，请查看运行记录';
    tab.value = 'history';
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
  () => draft.value.cron,
  () => {
    preview.value = null;
  },
);
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  await action(async () => {
    channels.value = (await api<ChannelSettings>('/channels')).accounts;
  });
  if (alive)
    timer = setTimeout(() => {
      void refresh();
    }, 5000);
});
onUnmounted(() => {
  alive = false;
  clearTimeout(timer);
  window.removeEventListener('beforeunload', beforeUnload);
});

/** 编辑内容是否尚未保存。 */
const editorDirty = computed(() => editorOpen.value && dirty.value);
useDirtyGuard(editorDirty);
/** 检查未保存内容后关闭编辑器。 */
const closeEditor = async (done: () => void) => {
  if (!dirty.value || (await confirmAction('放弃尚未保存的定时计划？'))) {
    baseline.value = JSON.stringify(draft.value);
    done();
  }
};
</script>

<template>
  <div class="page-content feature-panel">
    <section aria-label="定时任务">
      <section class="settings-panel">
        <h2>
          定时任务<span v-if="settings.unread"> · {{ settings.unread }} 条未读提醒</span>
        </h2>
        <p>
          按服务器时区
          {{ settings.timezone || '读取中…' }}
          执行。服务保持运行即可，无需打开网页。停机错过的触发不补跑。
        </p>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <p v-if="settings.schedulerError" role="alert">
          {{ settings.schedulerError }}
        </p>
        <el-alert v-if="notice" :title="notice" type="info" :closable="false" show-icon />
        <el-button :disabled="busy" @click="action(async () => {})" native-type="submit"
          >刷新定时任务</el-button
        >
        <el-button :disabled="busy" @click="edit(null)" native-type="submit"
          >新增定时计划</el-button
        >
        <p v-if="!loaded && !error">正在读取定时任务…</p>
        <p v-else-if="loaded && !settings.schedules.length">还没有定时计划。</p>
        <el-tabs v-model="tab"
          ><el-tab-pane label="定时计划" name="plans" /><el-tab-pane
            :label="`执行记录${settings.unread ? `（${settings.unread} 未读）` : ''}`"
            name="history"
        /></el-tabs>
        <div
          v-if="tab === 'plans' && settings.schedules.length"
          class="batch-toolbar"
          aria-label="批量操作"
        >
          <span>已选择 {{ selectedSchedules.length }} 项</span>
          <el-button :disabled="busy || !selectedSchedules.length" @click="batchSchedules('enable')"
            >批量启用</el-button
          >
          <el-button
            :disabled="busy || !selectedSchedules.length"
            @click="batchSchedules('disable')"
            >批量禁用</el-button
          >
          <el-button
            type="danger"
            plain
            :disabled="busy || !selectedSchedules.length"
            @click="batchSchedules('delete')"
            >批量删除</el-button
          >
        </div>
        <el-table
          ref="scheduleTable"
          v-if="tab === 'plans'"
          class="desktop-data"
          :data="settings.schedules"
          row-key="id"
          @selection-change="selectRows"
          empty-text="还没有定时计划"
          ><el-table-column
            type="selection"
            width="55"
            align="center"
            reserve-selection
          /><el-table-column prop="name" label="计划名称" min-width="150" /><el-table-column
            label="类型"
            width="100"
            ><template #default="{ row }">{{ kindLabel(row.kind) }}</template></el-table-column
          ><el-table-column prop="cron" label="执行规则" min-width="130" /><el-table-column
            label="下次执行"
            min-width="180"
            ><template #default="{ row }">{{ row.nextRunAt ?? '—' }}</template></el-table-column
          ><el-table-column label="结果投递" width="100"
            ><template #default="{ row }">{{
              channelName(typeof row.deliveryChannelId === 'string' ? row.deliveryChannelId : null)
            }}</template></el-table-column
          ><el-table-column label="状态" width="95" align="center"
            ><template #default="{ $index }"
              ><el-switch
                v-if="settings.schedules[$index]"
                :model-value="settings.schedules[$index]!.enabled"
                :disabled="busy || settings.schedules[$index]!.kind === 'reminder'"
                :loading="busy"
                :aria-label="`${settings.schedules[$index]!.name}状态`"
                @change="toggle(settings.schedules[$index]!)" /></template></el-table-column
          ><el-table-column label="操作" min-width="220" align="center" header-align="center"
            ><template #default="{ $index }"
              ><div v-if="settings.schedules[$index]" class="table-actions">
                <el-button text :disabled="busy" @click="edit(settings.schedules[$index]!)"
                  >编辑</el-button
                ><el-button
                  text
                  :disabled="busy || settings.schedules[$index]!.kind === 'reminder'"
                  @click="run(settings.schedules[$index]!)"
                  >立即运行</el-button
                ><el-button
                  text
                  type="danger"
                  :disabled="busy"
                  @click="remove(settings.schedules[$index]!)"
                  >删除</el-button
                >
              </div></template
            ></el-table-column
          ></el-table
        >
        <div v-if="tab === 'plans'" class="mobile-data">
          <el-card v-for="schedule in settings.schedules" :key="schedule.id" shadow="never">
            <el-checkbox
              :model-value="selectedIds.includes(schedule.id)"
              :disabled="busy"
              @change="selectOne(schedule.id, Boolean($event))"
              >选择此计划</el-checkbox
            >
            <h3>{{ schedule.name }}</h3>
            <el-tag :type="schedule.enabled ? 'success' : 'info'">{{
              schedule.enabled ? '已启用' : '已暂停'
            }}</el-tag>
            <p>
              {{ kindLabel(schedule.kind) }} ·
              {{ schedule.cron }}
            </p>
            <p>下次执行：{{ schedule.nextRunAt ?? '—' }}</p>
            <p>结果投递：{{ channelName(schedule.deliveryChannelId) }}</p>
            <div class="card-actions">
              <el-button :disabled="busy" @click="edit(schedule)">编辑</el-button>
              <el-button
                :disabled="busy || schedule.kind === 'reminder'"
                @click="toggle(schedule)"
                >{{ schedule.enabled ? '暂停' : '启用' }}</el-button
              >
              <el-button :disabled="busy || schedule.kind === 'reminder'" @click="run(schedule)"
                >立即运行</el-button
              >
              <el-button type="danger" plain :disabled="busy" @click="remove(schedule)"
                >删除</el-button
              >
            </div>
          </el-card>
        </div>
        <el-drawer
          v-model="editorOpen"
          :title="editing ? '编辑定时计划' : '新建定时计划'"
          size="600px"
          destroy-on-close
          :before-close="closeEditor"
          ><div class="feature-panel">
            <el-alert v-if="error" :title="error" type="error" :closable="false" />
            <el-form label-position="top" :disabled="busy" @submit.prevent="save">
              <h3>{{ editing ? '编辑定时计划' : '新建定时计划' }}</h3>
              <p v-if="dirty">有未保存的修改</p>
              <fieldset :disabled="busy">
                <el-form-item
                  ><template #label>计划名称</template
                  ><el-input aria-label="计划名称" v-model="draft.name" required maxlength="100"
                /></el-form-item>
                <label
                  >任务类型<el-select v-model="draft.kind" aria-label="任务类型"
                    ><el-option value="command" label="脚本任务" /><el-option
                      v-if="draft.kind === 'reminder'"
                      value="reminder"
                      disabled
                      label="旧固定提醒（已停用）" /><el-option
                      value="agent"
                      label="只读 AI 任务" /></el-select
                ></label>
                <label
                  >投递渠道<el-select v-model="deliveryChoice" aria-label="投递渠道">
                    <el-option value="" label="仅站内" />
                    <el-option
                      v-for="channel in channels"
                      :key="channel.id"
                      :value="channel.id"
                      :disabled="!channel.scheduleDelivery.available"
                      :label="`${channel.displayName} · ${channel.scheduleDelivery.statusLabel}`"
                    />
                    <el-option
                      v-if="
                        draft.deliveryChannelId &&
                        !channels.some((channel) => channel.id === draft.deliveryChannelId)
                      "
                      :value="draft.deliveryChannelId"
                      disabled
                      label="原渠道已移除，请重新选择"
                    /> </el-select
                ></label>
                <p>
                  QQ／微信发送给已绑定本人，邮箱与 Webhook
                  发送到管理员配置的地址。结果始终保留在站内；渠道发送失败不会重新执行任务。
                </p>
                <p v-if="draft.deliveryChannelId">
                  QQ 发送受机器人主动消息权限限制；微信使用最近的会话上下文；Webhook
                  按配置的请求发送；邮箱通过 SMTP
                  投递。发送结果可在下方记录查看，长内容会截断，完整结果保留在网页。
                </p>
                <div class="quick-cron">
                  <el-button native-type="button" @click="draft.cron = '0 9 * * *'"
                    >每天 9 点</el-button
                  ><el-button native-type="button" @click="draft.cron = '0 9 * * 1-5'"
                    >工作日 9 点</el-button
                  >
                </div>
                <el-form-item
                  ><template #label>Cron 表达式</template
                  ><el-input
                    aria-label="Cron 表达式"
                    v-model="draft.cron"
                    required
                    maxlength="100"
                    placeholder="0 9 * * *"
                    aria-describedby="cron-help"
                /></el-form-item>
                <p id="cron-help">
                  五段：分 时 日 月 周。例如 0 9 * * * 为每天 9 点，0 9 * * 1-5 为周一至周五 9
                  点。支持数字、*、逗号、范围和步长，不支持秒。
                </p>
                <el-button
                  native-type="button"
                  @click="
                    action(async () => {
                      preview = await api<SchedulePreview>('/schedules/preview', 'POST', {
                        cron: draft.cron,
                      });
                    })
                  "
                  >预览执行时间</el-button
                >
                <div v-if="preview" aria-label="执行时间预览">
                  <p>未来 5 次（{{ preview.timezone }}）</p>
                  <ul>
                    <li v-for="date in preview.nextRuns" :key="date">
                      {{ time(date) }}
                    </li>
                  </ul>
                </div>
                <el-form-item
                  ><template #label>{{
                    draft.kind === 'agent' ? '任务提示词' : '执行命令'
                  }}</template
                  ><el-input
                    :type="draft.kind === 'command' ? 'text' : 'textarea'"
                    :placeholder="draft.kind === 'command' ? 'python scripts/report.py' : ''"
                    v-model="draft.content"
                    required
                    maxlength="8000"
                    :rows="4"
                /></el-form-item>
                <template v-if="draft.kind === 'command' && draft.commandOptions">
                  <p>
                    统一从工作区根目录执行，命令中填写解释器和脚本路径，例如 venv/bin/python
                    scripts/test/index.py。
                  </p>
                  <el-form-item label="超时时间（秒）"
                    ><el-input-number
                      aria-label="超时时间（秒）"
                      v-model="commandTimeoutSeconds"
                      :min="1"
                      :max="300"
                  /></el-form-item>
                  <p>
                    直接执行，不调用
                    AI。仅输入一条命令，多步操作请写入脚本文件。支持单/双引号参数，不支持管道、重定向或内联脚本。启用计划即允许重复执行，每次运行使用最新脚本；修改脚本后下次调度直接生效。
                  </p>
                </template>
                <p v-if="draft.kind === 'agent'">
                  使用执行时的全局默认模型和助手配置，可能产生模型费用。可读取授权工作目录；在“联网搜索”中单独允许定时任务联网后，还可查询公开资料，可能消耗搜索服务额度。不能写入文件或执行命令；每次结果保存到独立会话。忙碌最多等待
                  10 分钟。
                </p>
                <el-form-item
                  ><el-checkbox v-model="draft.enabled">启用定时计划</el-checkbox></el-form-item
                >
                <el-button type="primary" native-type="submit">保存定时计划</el-button>
                <el-button
                  v-if="editing"
                  native-type="button"
                  @click="edit(settings.schedules.find((item) => item.id === editing?.id) ?? null)"
                  >重新加载计划草稿</el-button
                >
              </fieldset>
            </el-form>
          </div></el-drawer
        >
        <div v-if="tab === 'history'">
          <h3>执行记录</h3>
          <label
            >执行记录筛选<el-select
              v-model="filter"
              :disabled="busy"
              @change="
                action(async () => {
                  pageBefore = null;
                })
              "
              ><el-option value="" label="所有计划（含已删除）" /><el-option
                v-for="schedule in settings.schedules"
                :key="schedule.id"
                :value="schedule.id"
                :label="`${schedule.name}`" /></el-select
          ></label>
          <el-form-item
            ><el-checkbox
              v-if="settings.unread || unreadOnly"
              v-model="unreadOnly"
              :disabled="busy"
              @change="
                action(async () => {
                  pageBefore = null;
                })
              "
              >仅显示未读提醒</el-checkbox
            ></el-form-item
          >
          <p v-if="loaded && !history.occurrences.length">暂无符合条件的执行记录。</p>
          <article
            v-for="item in history.occurrences"
            :key="item.id"
            :aria-label="`执行：${item.snapshot.name}`"
          >
            <strong>{{ item.snapshot.name }} · {{ labels[item.status] }}</strong>
            <p>
              {{ item.source === 'manual' ? '手动触发' : 'Cron 触发' }} ·
              {{ time(item.scheduledAt) }}（计划时区：{{ item.snapshot.timezone }}）
            </p>
            <p v-if="item.reason">{{ item.reason }}</p>
            <div v-if="item.commandResult" aria-label="命令执行结果">
              <p>
                退出码：{{ item.commandResult.exitCode ?? '未知' }} · 耗时：{{
                  item.commandResult.durationMs
                }}
                毫秒
              </p>
              <details open>
                <summary>标准输出</summary>
                <pre class="command-output">{{ item.commandResult.stdout || '（无输出）' }}</pre>
              </details>
              <details>
                <summary>错误输出</summary>
                <pre class="command-output">{{ item.commandResult.stderr || '（无输出）' }}</pre>
              </details>
            </div>
            <p v-if="item.delivery">
              {{
                item.delivery.kind === 'email'
                  ? '邮箱'
                  : item.delivery.kind === 'qq'
                    ? 'QQ'
                    : item.delivery.kind === 'webhook'
                      ? 'Webhook'
                      : '微信'
              }}
              ·
              {{
                item.delivery.kind === 'email' && item.delivery.status === 'sent'
                  ? '邮件服务器已接受'
                  : (deliveryLabels[item.delivery.status] ?? item.delivery.status)
              }}<span v-if="item.delivery.error">：{{ item.delivery.error }}</span>
            </p>
            <p v-else-if="item.snapshot.deliveryChannelId">渠道投递将在本次执行成功后开始。</p>
            <template v-if="item.snapshot.kind === 'reminder' && item.status === 'succeeded'">
              <p class="reminder-content">{{ item.snapshot.content }}</p>
              <el-button
                v-if="!item.readAt"
                :disabled="busy"
                @click="
                  action(async () => {
                    await api(`/schedule-occurrences/${item.id}/read`, 'POST');
                  })
                "
                native-type="submit"
                >标为已读</el-button
              >
              <p v-else>已读</p>
            </template>
            <el-button
              v-if="item.conversationId"
              :disabled="busy"
              @click="router.push(`/chat/${item.conversationId}`)"
              native-type="submit"
              >打开结果会话</el-button
            >
            <el-button
              v-if="['pending', 'running'].includes(item.status)"
              :disabled="busy"
              @click="
                action(async () => {
                  await api(`/schedule-occurrences/${item.id}/cancel`, 'POST');
                })
              "
              native-type="submit"
              >取消本次执行</el-button
            >
          </article>
          <el-button
            v-if="pageBefore"
            :disabled="busy"
            @click="
              action(async () => {
                pageBefore = null;
              })
            "
            native-type="submit"
            >返回最新记录</el-button
          >
          <el-button
            v-if="history.nextCursor"
            :disabled="busy"
            @click="
              action(async () => {
                pageBefore = history.nextCursor;
              })
            "
            native-type="submit"
            >更早执行记录</el-button
          >
        </div>
      </section>
    </section>
  </div>
</template>

<style scoped>
.command-output {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 24rem;
  overflow: auto;
}
</style>
