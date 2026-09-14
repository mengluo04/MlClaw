<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type {
  SystemLogLevel,
  SystemLogPage,
  SystemLogRecord,
  SystemLogSettings,
  SystemLogSource,
} from '@mlclaw/shared';
import { api } from '../api';
import { useOperation } from '../composables/operation';

/** 统一操作状态：忙碌、错误提示及执行入口。 */
const { busy, error, run } = useOperation();
/** 待处理条目列表。 */
const items = ref<SystemLogRecord[]>([]);
/** 等待后续处理的数据。 */
const pending = ref<SystemLogRecord[]>([]);
/** 下一页数据的游标。 */
const nextCursor = ref<string | null>(null);
/** 最近已知事件标识，用于实时订阅续传。 */
const latestId = ref(0);
/** 当前日志等级。 */
const level = ref<SystemLogLevel | ''>('');
/** 当前操作的数据来源或源对象。 */
const source = ref<SystemLogSource | ''>('');
/** 是否已完成首次数据加载。 */
const loaded = ref(false);
/** 实时连接当前状态。 */
const liveState = ref<'connecting' | 'live' | 'paused' | 'retrying'>('connecting');
/** 是否暂停实时更新。 */
const paused = ref(false);
/** 当前详情数据。 */
const detail = ref<SystemLogRecord | null>(null);
/** 详情面板是否打开。 */
const detailOpen = ref(false);
/** 当前功能设置。 */
const settings = ref<SystemLogSettings | null>(null);
/** 系统日志保留天数。 */
const retentionDays = ref(7);
/** 当前系统日志记录等级。 */
const logLevel = ref<SystemLogSettings['logLevel']>('info');
/** 当前数据流。 */
let stream: EventSource | null = null;

/** 日志来源对应的中文标签。 */
const sourceLabels: Record<SystemLogSource, string> = {
  system: '系统',
  auth: '登录',
  task: '任务',
  schedule: '定时任务',
  channel: '消息渠道',
  model: '模型服务',
  web: '联网搜索',
  executor: '执行服务',
  storage: '文件操作',
};
/** 日志等级对应的中文标签。 */
const levelLabels: Record<SystemLogLevel, string> = {
  info: '信息',
  warning: '警告',
  error: '错误',
};
/** 取得当前允许展示的数据。 */
const visible = (item: SystemLogRecord) =>
  (!level.value || item.level === level.value) && (!source.value || item.source === source.value);
/** 实时连接状态展示文案。 */
const liveLabel = computed(() =>
  paused.value
    ? '已暂停页面更新'
    : liveState.value === 'live'
      ? '实时更新中'
      : liveState.value === 'retrying'
        ? '正在重连'
        : '正在连接',
);

/** 加载当前页面或业务所需的数据。 */
const load = async (older = false) => {
  /** 当前请求参数。 */
  const params = new URLSearchParams();
  if (older && nextCursor.value) params.set('before', nextCursor.value);
  if (level.value) params.set('level', level.value);
  if (source.value) params.set('source', source.value);
  /** 当前页面或分页结果。 */
  const page = await api<SystemLogPage>(`/system-logs?${params}`);
  items.value = older ? [...items.value, ...page.items] : page.items;
  nextCursor.value = page.nextCursor;
  latestId.value = Math.max(latestId.value, page.latestId);
  loaded.value = true;
};

/** 建立连接并注册消息与断开处理。 */
const connect = () => {
  stream?.close();
  liveState.value = 'connecting';
  stream = new EventSource(`/api/system-logs/stream?after=${latestId.value}`);
  stream.addEventListener('open', () => {
    liveState.value = paused.value ? 'paused' : 'live';
  });
  stream.addEventListener('log.created', (event) => {
    /** 当前处理的条目。 */
    const item = JSON.parse((event as MessageEvent).data) as SystemLogRecord;
    latestId.value = Math.max(latestId.value, item.id);
    if (!visible(item)) return;
    if (
      items.value.some((current) => current.id === item.id) ||
      pending.value.some((current) => current.id === item.id)
    )
      return;
    if (
      items.value.some((existing) => existing.id === item.id) ||
      pending.value.some((existing) => existing.id === item.id)
    )
      return;
    if (paused.value) pending.value.push(item);
    else items.value = [item, ...items.value].slice(0, 200);
  });
  stream.addEventListener('logs.reset', () => {
    void run(() => load());
  });
  stream.onerror = () => {
    if (!paused.value) liveState.value = 'retrying';
  };
};

/** 暂停或恢复系统日志实时订阅。 */
const togglePause = () => {
  paused.value = !paused.value;
  if (!paused.value) {
    items.value = [...pending.value.reverse(), ...items.value].slice(0, 200);
    pending.value = [];
    liveState.value = stream?.readyState === EventSource.OPEN ? 'live' : 'retrying';
  } else liveState.value = 'paused';
};

/** 重新加载数据并重置相关界面状态。 */
const reload = async () => {
  pending.value = [];
  latestId.value = 0;
  await load();
  connect();
};
/** 重新连接并加载失败的数据。 */
const retry = async () => {
  settings.value = await api<SystemLogSettings>('/system-log-settings');
  retentionDays.value = settings.value.retentionDays;
  logLevel.value = settings.value.logLevel;
  await reload();
};
/** 保存当前页面的设置。 */
const saveSettings = async () => {
  if (!settings.value) return;
  settings.value = await api<SystemLogSettings>('/system-log-settings', 'PUT', {
    retentionDays: retentionDays.value,
    logLevel: logLevel.value,
    expectedVersion: settings.value.version,
  });
  retentionDays.value = settings.value.retentionDays;
  logLevel.value = settings.value.logLevel;
  await reload();
};
/** 生成日志关联业务对象的跳转地址。 */
const related = (item: SystemLogRecord) => {
  return item.entityType === 'schedule' || item.entityType === 'occurrence'
    ? '/schedules?tab=history'
    : item.entityType === 'task' || item.entityType === 'tool'
      ? '/history'
      : null;
};
/** 加载并展示所选记录的详情。 */
const inspect = (item: unknown) => {
  detail.value = item as SystemLogRecord;
  detailOpen.value = true;
};

onMounted(
  () =>
    void run(async () => {
      [settings.value] = await Promise.all([
        api<SystemLogSettings>('/system-log-settings'),
        load(),
      ]);
      retentionDays.value = settings.value.retentionDays;
      logLevel.value = settings.value.logLevel;
      connect();
    }),
);
onBeforeUnmount(() => stream?.close());
</script>

<template>
  <div class="page-content feature-panel">
    <section>
      <h2>系统日志</h2>
      <p>
        查看服务、定时任务、渠道和后台操作的关键活动。记录等级同时控制新活动记录与标准输出，保存后立即生效，已有记录保留。
      </p>
      <el-alert v-if="error" :title="error" type="error" :closable="false"
        ><el-button text @click="run(retry)">重试</el-button></el-alert
      >
      <div class="log-settings">
        <el-tag
          :type="liveState === 'live' ? 'success' : liveState === 'retrying' ? 'warning' : 'info'"
          >{{ liveLabel }}</el-tag
        >
        <el-button @click="togglePause">{{ paused ? '继续实时更新' : '暂停页面更新' }}</el-button>
        <span v-if="pending.length">暂停期间有 {{ pending.length }} 条新日志</span>
        <span class="log-spacer" />
        <label for="record-level">记录等级</label>
        <el-select
          id="record-level"
          v-model="logLevel"
          aria-label="记录等级"
          :disabled="busy"
          style="width: 160px"
        >
          <el-option value="info" label="信息及以上" /><el-option
            value="warn"
            label="警告及以上"
          /><el-option value="error" label="仅错误" />
        </el-select>
        <label for="retention-days">保留天数</label>
        <el-input-number
          id="retention-days"
          v-model="retentionDays"
          :min="1"
          :max="30"
          :disabled="busy"
        />
        <el-button
          :loading="busy"
          :disabled="
            !settings ||
            (retentionDays === settings.retentionDays && logLevel === settings.logLevel)
          "
          @click="run(saveSettings)"
          >保存</el-button
        >
      </div>
      <el-form class="history-filters" @submit.prevent="run(reload)">
        <el-select v-model="level" aria-label="日志级别" placeholder="所有级别" clearable>
          <el-option value="info" label="信息" /><el-option
            value="warning"
            label="警告"
          /><el-option value="error" label="错误" />
        </el-select>
        <el-select v-model="source" aria-label="日志来源" placeholder="所有来源" clearable>
          <el-option
            v-for="(label, value) in sourceLabels"
            :key="value"
            :value="value"
            :label="label"
          />
        </el-select>
        <el-button native-type="submit" :loading="busy">查询</el-button>
      </el-form>
      <el-skeleton v-if="busy && !loaded" :rows="5" animated />
      <el-table v-else class="desktop-data" :data="items" empty-text="暂无符合条件的日志">
        <el-table-column label="级别" width="90"
          ><template #default="{ row }"
            ><el-tag
              :type="
                row.level === 'error' ? 'danger' : row.level === 'warning' ? 'warning' : 'info'
              "
              >{{ levelLabels[row.level as SystemLogLevel] }}</el-tag
            ></template
          ></el-table-column
        >
        <el-table-column label="来源" width="110"
          ><template #default="{ row }">{{
            sourceLabels[row.source as SystemLogSource]
          }}</template></el-table-column
        >
        <el-table-column prop="message" label="活动" min-width="260" show-overflow-tooltip />
        <el-table-column prop="createdAt" label="时间" width="180" />
        <el-table-column label="操作" width="90"
          ><template #default="{ row }"
            ><el-button text @click="inspect(row)">详情</el-button></template
          ></el-table-column
        >
      </el-table>
      <div class="mobile-data">
        <el-empty v-if="loaded && !items.length" description="暂无符合条件的日志" /><el-card
          v-for="item in items"
          :key="item.id"
          shadow="never"
          ><p>
            <el-tag>{{ levelLabels[item.level] }}</el-tag> {{ sourceLabels[item.source] }}
          </p>
          <h3>{{ item.message }}</h3>
          <p>{{ item.createdAt }}</p>
          <el-button @click="inspect(item)">详情</el-button></el-card
        >
      </div>
      <el-button v-if="nextCursor" :loading="busy" @click="run(() => load(true))"
        >加载更早日志</el-button
      >
      <el-drawer v-model="detailOpen" title="日志详情" size="560px" destroy-on-close>
        <div v-if="detail" class="feature-panel">
          <el-tag>{{ levelLabels[detail.level] }}</el-tag>
          <h3>{{ detail.message }}</h3>
          <p>{{ sourceLabels[detail.source] }} · {{ detail.createdAt }}</p>
          <p>
            事件：<code>{{ detail.event }}</code>
          </p>
          <pre v-if="detail.metadata">{{ JSON.stringify(detail.metadata, null, 2) }}</pre>
          <RouterLink v-if="related(detail)" :to="related(detail)!!">查看相关记录</RouterLink>
        </div>
      </el-drawer>
    </section>
  </div>
</template>
