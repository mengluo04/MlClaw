<script setup lang="ts">
import { useRoute } from "vue-router";
import { useDirtyGuard } from "../composables/dirty";
import { confirmAction } from "../composables/confirm";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type {
  ChannelSettings,
  Schedule,
  ScheduleBatchOperation,
  ScheduleBatchResult,
  ScheduleHistory,
  ScheduleInput,
  ScheduleList,
  SchedulePreview,
} from "@mlclaw/shared";
import { api, ApiError } from "../api";

const emit = defineEmits<{ expired: []; open: [conversationId: string] }>();
const settings = ref<ScheduleList>({
  schedules: [],
  timezone: "",
  schedulerError: null,
  unread: 0,
});
const history = ref<ScheduleHistory>({ occurrences: [], nextCursor: null });
const channels = ref<ChannelSettings["accounts"]>([]);
const deliveryLabels: Record<string, string> = {
  pending: "等待投递",
  sending: "发送中",
  sent: "平台已确认发送",
  failed: "发送失败",
  unknown: "发送结果未确认",
  cancelled: "未投递",
};
function channelName(id: string | null | undefined) {
  if (!id) return "仅站内";
  const channel = channels.value.find((item) => item.id === id);
  return channel ? (channel.kind === "qq" ? "QQ" : "微信") : "渠道已移除";
}
const loaded = ref(false);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const route = useRoute();
const editorOpen = ref(false);
const tab = ref(route.query.tab === "history" ? "history" : "plans");
watch(
  () => route.query.tab,
  (value) => {
    if (value === "history") tab.value = "history";
  },
);
const editing = ref<Schedule | null>(null);
const fresh = (): ScheduleInput => ({
  name: "",
  kind: "reminder",
  content: "",
  cron: "0 9 * * *",
  enabled: true,
  deliveryChannelId: null,
});
const draft = ref<ScheduleInput>(fresh());
const baseline = ref(JSON.stringify(draft.value));
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value);
const deliveryChoice = computed({
  get: () => draft.value.deliveryChannelId ?? "",
  set: (value: string) => {
    draft.value.deliveryChannelId = value || null;
  },
});
const preview = ref<SchedulePreview | null>(null);
const filter = ref("");
const unreadOnly = ref(false);
const pageBefore = ref<number | null>(null);
const labels: Record<string, string> = {
  pending: "等待执行",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
  interrupted: "已中断",
};
const pendingRuns = new Map<
  string,
  { idempotencyKey: string; expectedVersion: number }
>();
const selectedIds = ref<string[]>([]);
const selectedSchedules = computed(() =>
  settings.value.schedules.filter((schedule) =>
    selectedIds.value.includes(schedule.id),
  ),
);
const scheduleTable = ref<{ clearSelection: () => void }>();
let alive = true;
let refreshing = false;
let refreshPromise: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
function fail(reason: unknown) {
  if (!alive) return;
  if (reason instanceof ApiError && reason.status === 401) emit("expired");
  error.value =
    reason instanceof Error ? reason.message : "定时任务操作失败，请重试";
}
function time(value: string | null) {
  return value ?? "—";
}
async function load() {
  const query = new URLSearchParams();
  if (filter.value) query.set("scheduleId", filter.value);
  if (unreadOnly.value) query.set("unread", "true");
  if (pageBefore.value) query.set("before", String(pageBefore.value));
  const queryKey = query.toString();
  const [list, records] = await Promise.all([
    api<ScheduleList>("/schedules"),
    api<ScheduleHistory>(`/schedule-occurrences?${queryKey}`),
  ]);
  if (!alive) return;
  settings.value = list;
  const existingIds = new Set(list.schedules.map((schedule) => schedule.id));
  selectedIds.value = selectedIds.value.filter((id) => existingIds.has(id));
  history.value = records;
  loaded.value = true;
}
async function action(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await refreshPromise;
    if (!alive) return;
    await operation();
    await load();
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
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
}
async function edit(schedule: Schedule | null) {
  if (
    dirty.value &&
    !(await confirmAction("切换计划将丢弃未保存的草稿，是否继续？"))
  )
    return;
  try {
    channels.value = (await api<ChannelSettings>("/channels")).accounts;
  } catch (cause) {
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
      }
    : fresh();
  baseline.value = JSON.stringify(draft.value);
  preview.value = null;
  notice.value = "";
}
async function save() {
  await action(async () => {
    const saved = await api<Schedule>(
      editing.value ? `/schedules/${editing.value.id}` : "/schedules",
      editing.value ? "PUT" : "POST",
      {
        ...draft.value,
        ...(editing.value ? { expectedVersion: editing.value.version } : {}),
      },
    );
    editing.value = saved;
    baseline.value = JSON.stringify(draft.value);
    notice.value = "定时计划已保存";
    editorOpen.value = false;
  });
}
async function toggle(schedule: Schedule) {
  await action(async () => {
    await api(`/schedules/${schedule.id}`, "PUT", {
      name: schedule.name,
      kind: schedule.kind,
      content: schedule.content,
      cron: schedule.cron,
      enabled: !schedule.enabled,
      deliveryChannelId: schedule.deliveryChannelId ?? null,
      expectedVersion: schedule.version,
    });
    notice.value = schedule.enabled
      ? "计划已暂停，未启动的执行已取消；运行中的执行可单独取消"
      : "计划已启用";
  });
}
function selectRows(rows: Schedule[]) {
  selectedIds.value = rows.map((row) => row.id);
}
function selectOne(id: string, selected: boolean) {
  selectedIds.value = selected
    ? [...new Set([...selectedIds.value, id])]
    : selectedIds.value.filter((item) => item !== id);
}
async function batchSchedules(operation: ScheduleBatchOperation) {
  const schedules = selectedSchedules.value;
  if (!schedules.length) return;
  if (
    operation === "delete" &&
    !(await confirmAction(
      `确定删除选中的 ${schedules.length} 个定时计划？未启动的执行将取消，已有历史和运行中的执行保留。`,
      "批量删除定时计划",
    ))
  )
    return;
  await action(async () => {
    const result = await api<ScheduleBatchResult>("/schedules/batch", "POST", {
      operation,
      items: schedules.map((schedule) => ({
        id: schedule.id,
        expectedVersion: schedule.version,
      })),
    });
    if (operation === "delete") {
      if (editing.value && selectedIds.value.includes(editing.value.id)) {
        baseline.value = JSON.stringify(draft.value);
        editorOpen.value = false;
        editing.value = null;
      }
      if (selectedIds.value.includes(filter.value)) filter.value = "";
    }
    scheduleTable.value?.clearSelection();
    selectedIds.value = [];
    const actionLabel =
      operation === "enable" ? "启用" : operation === "disable" ? "禁用" : "删除";
    notice.value = `已批量${actionLabel} ${result.updated} 个定时计划`;
  });
}
async function remove(schedule: Schedule) {
  if (
    !(await confirmAction(
      "删除此计划将停止未来触发并取消未启动的执行；已有提醒、结果和运行中的执行保留。是否继续？",
    ))
  )
    return;
  await action(async () => {
    await api(`/schedules/${schedule.id}`, "DELETE", {
      expectedVersion: schedule.version,
    });
    if (editing.value?.id === schedule.id) {
      baseline.value = JSON.stringify(draft.value);
      await edit(null);
      editorOpen.value = false;
    }
    if (filter.value === schedule.id) filter.value = "";
    notice.value = "定时计划已删除，执行历史保留";
  });
}
async function run(schedule: Schedule) {
  await action(async () => {
    const request = pendingRuns.get(schedule.id) ?? {
      idempotencyKey: crypto.randomUUID(),
      expectedVersion: schedule.version,
    };
    pendingRuns.set(schedule.id, request);
    try {
      await api(`/schedules/${schedule.id}/run`, "POST", request);
      pendingRuns.delete(schedule.id);
    } catch (reason) {
      if (
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500
      )
        pendingRuns.delete(schedule.id);
      throw reason;
    }
    pageBefore.value = null;
    filter.value = schedule.id;
    unreadOnly.value = false;
    notice.value = "执行已登记，请查看运行记录";
    tab.value = "history";
  });
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
watch(
  () => draft.value.cron,
  () => {
    preview.value = null;
  },
);
onMounted(async () => {
  window.addEventListener("beforeunload", beforeUnload);
  await action(async () => {
    channels.value = (await api<ChannelSettings>("/channels")).accounts;
  });
  if (alive)
    timer = setTimeout(() => {
      void refresh();
    }, 5000);
});
onUnmounted(() => {
  alive = false;
  clearTimeout(timer);
  window.removeEventListener("beforeunload", beforeUnload);
});

const editorDirty = computed(() => editorOpen.value && dirty.value);
useDirtyGuard(editorDirty);
async function closeEditor(done: () => void) {
  if (!dirty.value || (await confirmAction("放弃尚未保存的定时计划？"))) {
    baseline.value = JSON.stringify(draft.value);
    done();
  }
}
</script>

<template>
  <section aria-label="定时任务">
    <section class="settings-panel">
      <h2>
        定时任务<span v-if="settings.unread">
          · {{ settings.unread }} 条未读提醒</span
        >
      </h2>
      <p>
        按服务器时区
        {{ settings.timezone || "读取中…" }}
        执行。服务保持运行即可，无需打开网页。停机错过的触发不补跑。
      </p>
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
      <p v-if="settings.schedulerError" role="alert">
        {{ settings.schedulerError }}
      </p>
      <el-alert
        v-if="notice"
        :title="notice"
        type="info"
        :closable="false"
        show-icon
      />
      <el-button
        :disabled="busy"
        @click="action(async () => {})"
        native-type="submit"
        >刷新定时任务</el-button
      >
      <el-button :disabled="busy" @click="edit(null)" native-type="submit"
        >新增定时计划</el-button
      >
      <p v-if="!loaded && !error">正在读取定时任务…</p>
      <p v-else-if="loaded && !settings.schedules.length">还没有定时计划。</p>
      <el-tabs v-model="tab"
        ><el-tab-pane label="定时计划" name="plans" /><el-tab-pane
          :label="`执行记录与提醒${settings.unread ? `（${settings.unread} 未读）` : ''}`"
          name="history"
      /></el-tabs>
      <div
        v-if="tab === 'plans' && settings.schedules.length"
        class="batch-toolbar"
        aria-label="批量操作"
      >
        <span>已选择 {{ selectedSchedules.length }} 项</span>
        <el-button
          :disabled="busy || !selectedSchedules.length"
          @click="batchSchedules('enable')"
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
        /><el-table-column
          prop="name"
          label="计划名称"
          min-width="150"
        /><el-table-column label="类型" width="100"
          ><template #default="{ row }">{{
            row.kind === "agent" ? "只读 AI" : "固定提醒"
          }}</template></el-table-column
        ><el-table-column
          prop="cron"
          label="执行规则"
          min-width="130"
        /><el-table-column label="下次执行" min-width="180"
          ><template #default="{ row }">{{
            row.nextRunAt ?? "—"
          }}</template></el-table-column
        ><el-table-column label="结果投递" width="100"
          ><template #default="{ row }">{{
            channelName(
              typeof row.deliveryChannelId === "string"
                ? row.deliveryChannelId
                : null,
            )
          }}</template></el-table-column
        ><el-table-column label="状态" width="95" align="center"
          ><template #default="{ $index }"
            ><el-switch
              v-if="settings.schedules[$index]"
              :model-value="settings.schedules[$index]!.enabled"
              :disabled="busy"
              :loading="busy"
              :aria-label="`${settings.schedules[$index]!.name}状态`"
              @change="toggle(settings.schedules[$index]!)"
            /></template
          ></el-table-column
        ><el-table-column
          label="操作"
          min-width="220"
          align="center"
          header-align="center"
          ><template #default="{ $index }"
            ><div v-if="settings.schedules[$index]" class="table-actions"
              ><el-button
                text
                :disabled="busy"
                @click="edit(settings.schedules[$index]!)"
                >编辑</el-button
              ><el-button
                text
                :disabled="busy"
                @click="run(settings.schedules[$index]!)"
                >立即运行</el-button
              ><el-button
                text
                type="danger"
                :disabled="busy"
                @click="remove(settings.schedules[$index]!)"
                >删除</el-button
              ></div
            ></template
          ></el-table-column
        ></el-table
      >
      <div v-if="tab === 'plans'" class="mobile-data">
        <el-card
          v-for="schedule in settings.schedules"
          :key="schedule.id"
          shadow="never"
        >
          <el-checkbox
            :model-value="selectedIds.includes(schedule.id)"
            :disabled="busy"
            @change="selectOne(schedule.id, Boolean($event))"
            >选择此计划</el-checkbox
          >
          <h3>{{ schedule.name }}</h3>
          <el-tag :type="schedule.enabled ? 'success' : 'info'">{{
            schedule.enabled ? "已启用" : "已暂停"
          }}</el-tag>
          <p>
            {{ schedule.kind === "agent" ? "只读 AI" : "固定提醒" }} ·
            {{ schedule.cron }}
          </p>
          <p>下次执行：{{ schedule.nextRunAt ?? "—" }}</p>
          <p>结果投递：{{ channelName(schedule.deliveryChannelId) }}</p>
          <div class="card-actions">
            <el-button :disabled="busy" @click="edit(schedule)">编辑</el-button>
            <el-button :disabled="busy" @click="toggle(schedule)">{{
              schedule.enabled ? "暂停" : "启用"
            }}</el-button>
            <el-button :disabled="busy" @click="run(schedule)"
              >立即运行</el-button
            >
            <el-button
              type="danger"
              plain
              :disabled="busy"
              @click="remove(schedule)"
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
          <el-alert
            v-if="error"
            :title="error"
            type="error"
            :closable="false"
          />
          <el-form label-position="top" :disabled="busy" @submit.prevent="save">
            <h3>{{ editing ? "编辑定时计划" : "新建定时计划" }}</h3>
            <p v-if="dirty">有未保存的修改</p>
            <fieldset :disabled="busy">
              <el-form-item
                ><template #label>计划名称</template
                ><el-input
                  aria-label="计划名称"
                  v-model="draft.name"
                  required
                  maxlength="100"
              /></el-form-item>
              <label
                >任务类型<el-select v-model="draft.kind" aria-label="任务类型"
                  ><el-option value="reminder" label="固定站内提醒" /><el-option
                    value="agent"
                    label="只读 AI 任务" /></el-select
              ></label>
              <label
                >投递渠道<el-select
                  v-model="deliveryChoice"
                  aria-label="投递渠道"
                >
                  <el-option value="" label="仅站内" />
                  <el-option
                    v-for="channel in channels"
                    :key="channel.id"
                    :value="channel.id"
                    :disabled="!channel.enabled || !channel.pairedSender"
                    :label="`${channel.kind === 'qq' ? 'QQ' : '微信'} · ${!channel.pairedSender ? '未绑定' : !channel.enabled ? '已停用' : '已绑定本人'}`"
                  />
                  <el-option
                    v-if="
                      draft.deliveryChannelId &&
                      !channels.some(
                        (channel) => channel.id === draft.deliveryChannelId,
                      )
                    "
                    :value="draft.deliveryChannelId"
                    disabled
                    label="原渠道已移除，请重新选择"
                  /> </el-select
              ></label>
              <p>
                自动使用 bind
                绑定的本人身份。结果始终保留在站内；渠道发送失败不会重新执行任务。
              </p>
              <p v-if="draft.deliveryChannelId">
                QQ
                发送受机器人主动消息权限限制；微信使用最近的会话上下文。发送结果可在下方记录查看，长内容会截断，完整结果保留在网页。
              </p>
              <div class="quick-cron">
                <el-button
                  native-type="button"
                  @click="draft.cron = '0 9 * * *'"
                  >每天 9 点</el-button
                ><el-button
                  native-type="button"
                  @click="draft.cron = '0 9 * * 1-5'"
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
                五段：分 时 日 月 周。例如 0 9 * * * 为每天 9 点，0 9 * * 1-5
                为周一至周五 9 点。支持数字、*、逗号、范围和步长，不支持秒。
              </p>
              <el-button
                native-type="button"
                @click="
                  action(async () => {
                    preview = await api<SchedulePreview>(
                      '/schedules/preview',
                      'POST',
                      { cron: draft.cron },
                    );
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
                  draft.kind === "agent" ? "任务提示词" : "提醒内容"
                }}</template
                ><el-input
                  type="textarea"
                  v-model="draft.content"
                  required
                  maxlength="8000"
                  :rows="4"
              /></el-form-item>
              <p v-if="draft.kind === 'agent'">
                使用执行时的全局默认模型和助手配置，可能产生模型费用。可读取授权工作目录；在“联网搜索”中单独允许定时任务联网后，还可查询公开资料，可能消耗搜索服务额度。不能写入文件或执行命令；每次结果保存到独立会话。忙碌最多等待
                10 分钟。
              </p>
              <el-form-item
                ><el-checkbox v-model="draft.enabled"
                  >启用定时计划</el-checkbox
                ></el-form-item
              >
              <el-button type="primary" native-type="submit"
                >保存定时计划</el-button
              >
              <el-button
                v-if="editing"
                native-type="button"
                @click="
                  edit(
                    settings.schedules.find(
                      (item) => item.id === editing?.id,
                    ) ?? null,
                  )
                "
                >重新加载计划草稿</el-button
              >
            </fieldset>
          </el-form>
        </div></el-drawer
      >
      <div v-if="tab === 'history'">
        <h3>执行记录与提醒</h3>
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
        <p v-if="loaded && !history.occurrences.length">
          暂无符合条件的执行记录。
        </p>
        <article
          v-for="item in history.occurrences"
          :key="item.id"
          :aria-label="`执行：${item.snapshot.name}`"
        >
          <strong>{{ item.snapshot.name }} · {{ labels[item.status] }}</strong>
          <p>
            {{ item.source === "manual" ? "手动触发" : "Cron 触发" }} ·
            {{ time(item.scheduledAt) }}（计划时区：{{
              item.snapshot.timezone
            }}）
          </p>
          <p v-if="item.reason">{{ item.reason }}</p>
          <p v-if="item.delivery">
            {{ item.delivery.kind === "qq" ? "QQ" : "微信" }} ·
            {{ deliveryLabels[item.delivery.status] ?? item.delivery.status
            }}<span v-if="item.delivery.error"
              >：{{ item.delivery.error }}</span
            >
          </p>
          <p v-else-if="item.snapshot.deliveryChannelId">
            渠道投递将在本次执行成功后开始。
          </p>
          <template
            v-if="
              item.snapshot.kind === 'reminder' && item.status === 'succeeded'
            "
          >
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
            @click="emit('open', item.conversationId)"
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
</template>
