<script setup lang="ts">
import { useSession } from '../stores/session';
import { useDirtyGuard } from '../composables/dirty';
import { confirmAction } from '../composables/confirm';
import { computed, onMounted, ref, watch } from 'vue';
import type {
  ModelProvider,
  ModelSettings,
  ProviderPreset,
  DiscoveredModels,
} from '@mlclaw/shared';
import { api, ApiError } from '../api';

/** 当前用户的登录与助手状态。 */
const session = useSession();
/** 当前功能设置。 */
const settings = ref<ModelSettings>({ providers: [], defaultModel: null });
/** 操作进行中标记，用于禁用重复提交。 */
const busy = ref(false);
/** 是否已完成首次数据加载。 */
const loaded = ref(false);
/** 当前操作反馈文案。 */
const notice = ref('');
/** 编辑器是否打开。 */
const editorOpen = ref(false);
/** 当前正在编辑的记录。 */
const editing = ref('');
/** 待保存的模型提供商显示名称。 */
const name = ref('');
/** 当前可选预设。 */
const presets = ref<ProviderPreset[]>([]);
/** 当前提供商预设标识。 */
const presetId = ref('custom');
/** 当前提供商预设。 */
const preset = computed(() => presets.value.find((p) => p.id === presetId.value));
/** 远程发现的模型列表。 */
const discovered = ref<DiscoveredModels | null>(null);
/** 模型选择控件中当前选中的模型标识。 */
const selectedModels = ref<string[]>([]);
/** 是否正在获取远程模型列表。 */
const fetchingModels = ref(false);
/** 模型发现失败的提示。 */
const discoveryError = ref('');
/** 模型选择控件的候选项。 */
const modelOptions = computed(() => {
  /** 按模型标识合并远程列表与已选项，避免刷新后丢失已有选择。 */
  const options = new Map((discovered.value?.models ?? []).map((m) => [m.id, m]));
  for (/* 逐项处理当前记录标识。 */ const id of selectedModels.value)
    if (!options.has(id)) options.set(id, { id, name: id });
  return [...options.values()];
});
/** 服务基础地址。 */
const baseUrl = ref('');
/** 手动输入的模型标识文本，保存时按行拆分。 */
const models = ref('');
/** 仅在当前调用或编辑流程中使用的服务密钥。 */
const apiKey = ref('');
/** 保存时是否清除已有服务密钥。 */
const clearKey = ref(false);
/** 编辑开始时的序列化基线，用于检测未保存修改。 */
const original = ref('');
/** 全局默认模型的当前选择。 */
const defaultChoice = ref('');
/** 连接测试使用的模型标识。 */
const testModel = ref('');
/** 正在编辑的已保存提供商，新增时为空。 */
const current = computed(() =>
  settings.value.providers.find((provider) => provider.id === editing.value),
);
/** 读取或构造当前编辑草稿。 */
const draft = () =>
  JSON.stringify([name.value, baseUrl.value, models.value, selectedModels.value, presetId.value]);
/** 合并多选项与手动输入并去重，作为本次待保存的模型列表。 */
const configuredModels = computed(() => [
  ...new Set([
    ...selectedModels.value,
    ...models.value
      .split('\n')
      .map((m) => m.trim())
      .filter(Boolean),
  ]),
]);
watch([baseUrl, apiKey, clearKey, presetId, editing], () => {
  discovered.value = null;
  discoveryError.value = '';
});
/** 应用提供商预设地址并处理密钥状态。 */
const choosePreset = () => {
  if (!preset.value) return;
  name.value = presetId.value === 'custom' ? '' : preset.value.name;
  baseUrl.value = preset.value.baseUrl;
  apiKey.value = '';
  clearKey.value = false;
  models.value = '';
  selectedModels.value = [];
};
/** 获取远程模型列表并更新可选项与加载状态。 */
const fetchModels = async () => {
  await action(async () => {
    fetchingModels.value = true;
    discoveryError.value = '';
    discovered.value = null;
    try {
      discovered.value = await api<DiscoveredModels>('/settings/model-discovery', 'POST', {
        ...(editing.value ? { providerId: editing.value } : {}),
        baseUrl: baseUrl.value,
        presetId: presetId.value,
        ...(clearKey.value ? { apiKey: '' } : apiKey.value ? { apiKey: apiKey.value } : {}),
      });
    } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
      discoveryError.value = error instanceof Error ? error.message : '获取失败，请重试';
      if (error instanceof ApiError && error.status === 401) session.clear();
    } finally {
      fetchingModels.value = false;
    }
  });
};
/** 当前草稿是否偏离已保存内容。 */
const dirty = computed(() => draft() !== original.value || !!apiKey.value || clearKey.value);
/** 页面可选的业务条目集合。 */
const choices = computed(() =>
  settings.value.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: JSON.stringify({ providerId: provider.id, model }),
      label: `${provider.name} / ${model}`,
    })),
  ),
);
/** 已保存的全局默认模型标识。 */
const savedDefault = computed(() =>
  settings.value.defaultModel ? JSON.stringify(settings.value.defaultModel) : '',
);
/** 统一处理操作期间的忙碌状态与错误反馈。 */
const action = async (fn: () => Promise<void>) => {
  if (busy.value) return;
  busy.value = true;
  notice.value = '';
  try {
    await fn();
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
    if (error instanceof ApiError && error.status === 401) session.clear();
    notice.value = error instanceof Error ? error.message : '操作失败，请重试';
  } finally {
    busy.value = false;
  }
};
/** 加载当前页面或业务所需的数据。 */
const load = async () => {
  /** config：当前流程使用的配置；catalog：当前可用条目目录。 */
  const [config, catalog] = await Promise.all([
    api<ModelSettings>('/settings/models'),
    api<{ providers: ProviderPreset[] }>('/settings/provider-presets'),
  ]);
  settings.value = config;
  presets.value = catalog.providers;
  loaded.value = true;
  defaultChoice.value = savedDefault.value;
  session.modelLabel =
    choices.value.find((choice) => choice.value === savedDefault.value)?.label ?? '尚未指定';
};
/** 加载所选记录进入编辑状态。 */
const edit = async (provider?: ModelProvider, force = false) => {
  if (busy.value && !force) return;
  if (!force && dirty.value && !(await confirmAction('切换提供商将丢弃未保存的修改，是否继续？')))
    return;
  editorOpen.value = true;
  editing.value = provider?.id ?? '';
  name.value = provider?.name ?? '';
  presetId.value = provider?.presetId ?? 'custom';
  discovered.value = null;
  selectedModels.value = [...(provider?.models ?? [])];
  discoveryError.value = '';
  baseUrl.value = provider?.baseUrl ?? '';
  models.value = '';
  apiKey.value = '';
  clearKey.value = false;
  testModel.value = provider?.models[0] ?? '';
  original.value = draft();
};
/** 校验并保存当前编辑内容。 */
const save = async () => {
  await action(async () => {
    if (!configuredModels.value.length || configuredModels.value.length > 50)
      throw new Error('请选择或填写 1–50 个模型');
    /** 接口 editing.value ? /settings/providers/${editing.value} : /settings/providers 返回的业务数据。 */
    const result = await api<{ id: string }>(
      editing.value ? `/settings/providers/${editing.value}` : '/settings/providers',
      editing.value ? 'PUT' : 'POST',
      {
        name: name.value,
        presetId: presetId.value,
        baseUrl: baseUrl.value,
        models: configuredModels.value,
        ...(clearKey.value ? { apiKey: '' } : apiKey.value ? { apiKey: apiKey.value } : {}),
      },
    );
    await load();
    await edit(
      settings.value.providers.find((provider) => provider.id === result.id),
      true,
    );
    notice.value = '提供商配置已保存';
  });
};
/** 删除指定记录并更新当前列表。 */
const remove = async () => {
  if (!(await confirmAction('确定删除该提供商及其模型配置？'))) return;
  await action(async () => {
    await api(`/settings/providers/${editing.value}`, 'DELETE');
    await load();
    await edit(undefined, true);
    editorOpen.value = false;
    notice.value = '提供商已删除';
  });
};
/** 保存全局默认模型选择。 */
const saveDefault = async () => {
  await action(async () => {
    await api('/settings/model-default', 'PUT', JSON.parse(defaultChoice.value));
    await load();
    notice.value = '全局默认模型已保存，未临时指定模型的新任务使用该模型';
  });
};
/** 执行当前配置的连接验证并显示结果。 */
const test = async () => {
  await action(async () => {
    await api(`/settings/providers/${editing.value}/test`, 'POST', {
      model: testModel.value,
    });
    notice.value = '模型连接成功';
  });
};
original.value = draft();
onMounted(() => action(load));

/** 当前页面是否存在未保存修改。 */
const pageDirty = computed(
  () => (editorOpen.value && dirty.value) || defaultChoice.value !== savedDefault.value,
);
useDirtyGuard(pageDirty);
/** 检查未保存内容后关闭编辑器。 */
const closeEditor = async (done: () => void) => {
  if (busy.value) return;
  if (!dirty.value || (await confirmAction('放弃尚未保存的提供商配置？'))) {
    apiKey.value = '';
    clearKey.value = false;
    original.value = draft();
    done();
  }
};
</script>

<template>
  <div class="page-content feature-panel">
    <section class="settings-panel">
      <h2>模型设置</h2>
      <p role="status">{{ notice }}</p>
      <p v-if="busy">正在处理…</p>
      <el-button v-if="!loaded && !busy" @click="action(load)" native-type="submit"
        >重新加载模型配置</el-button
      >
      <template v-if="loaded">
        <p>对话可临时切换模型；其余新任务使用全局默认模型，运行中的任务保留启动时的配置。</p>
        <p v-if="!settings.providers.length">
          尚未配置提供商，请先添加提供商及模型，再指定全局默认模型。
        </p>
        <el-form label-position="top" :disabled="busy" @submit.prevent="saveDefault">
          <label for="global-model">全局默认模型</label>
          <el-select id="global-model" v-model="defaultChoice" :disabled="busy || !choices.length">
            <el-option value="" disabled label="请选择默认模型" />
            <el-option
              v-for="choice in choices"
              :key="choice.value"
              :value="choice.value"
              :label="choice.label"
            />
          </el-select>
          <el-button
            type="primary"
            :disabled="busy || !defaultChoice || defaultChoice === savedDefault"
            native-type="submit"
            >保存默认模型</el-button
          >
        </el-form>
        <div class="page-toolbar">
          <h3>模型提供商</h3>
          <el-button
            type="primary"
            :disabled="busy || settings.providers.length >= 20"
            @click="edit()"
            >新增提供商</el-button
          >
        </div>
        <el-table class="desktop-data" :data="settings.providers" empty-text="尚未添加提供商"
          ><el-table-column prop="name" label="名称" min-width="130" /><el-table-column
            label="模型"
            min-width="200"
            ><template #default="{ row }">{{ row.models.join('、') }}</template></el-table-column
          ><el-table-column label="密钥" width="95"
            ><template #default="{ row }"
              ><el-tag :type="row.hasApiKey ? 'success' : 'info'">{{
                row.hasApiKey ? '已配置' : '未配置'
              }}</el-tag></template
            ></el-table-column
          ><el-table-column label="操作" width="80"
            ><template #default="{ row }"
              ><el-button text @click="edit(settings.providers.find((item) => item.id === row.id))"
                >编辑</el-button
              ></template
            ></el-table-column
          ></el-table
        >
        <div class="mobile-data">
          <el-card v-for="provider in settings.providers" :key="provider.id" shadow="never">
            <h3>{{ provider.name }}</h3>
            <p>{{ provider.models.join('、') }}</p>
            <p>密钥：{{ provider.hasApiKey ? '已配置' : '未配置' }}</p>
            <el-button :disabled="busy" @click="edit(provider)">编辑</el-button>
          </el-card>
        </div>
        <el-drawer
          destroy-on-close
          v-model="editorOpen"
          :title="editing ? '编辑提供商' : '新增提供商'"
          size="560px"
          :before-close="closeEditor"
          ><div class="feature-panel">
            <el-alert v-if="notice" :title="notice" type="info" :closable="false" />
            <el-form label-position="top" :disabled="busy" @submit.prevent="save">
              <h3>{{ editing ? '编辑提供商' : '新增提供商' }}</h3>
              <p v-if="dirty">提供商配置有未保存的修改。</p>
              <fieldset :disabled="busy">
                <el-form-item label="提供商预设">
                  <el-select
                    aria-label="提供商预设"
                    v-model="presetId"
                    filterable
                    @change="choosePreset"
                  >
                    <el-option
                      v-for="item in presets"
                      :key="item.id"
                      :value="item.id"
                      :label="item.name"
                    />
                  </el-select>
                </el-form-item>
                <el-link
                  v-if="preset?.docsUrl"
                  :href="preset.docsUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  type="primary"
                  >提供商官方文档</el-link
                >
                <el-form-item
                  ><template #label>提供商名称</template
                  ><el-input aria-label="提供商名称" v-model="name" required maxlength="100"
                /></el-form-item>
                <el-form-item
                  ><template #label>服务地址</template
                  ><el-input
                    aria-label="服务地址"
                    v-model="baseUrl"
                    placeholder="https://服务地址/v1"
                    required
                    maxlength="2048"
                /></el-form-item>
                <el-form-item
                  ><template #label>API 密钥</template
                  ><el-input
                    aria-label="API 密钥"
                    v-model="apiKey"
                    type="password"
                    autocomplete="off"
                    maxlength="4096"
                    :disabled="clearKey"
                    :placeholder="
                      current?.hasApiKey ? '已保存，留空保留；地址或预设改变则清除' : '尚未保存密钥'
                    "
                /></el-form-item>
                <el-form-item
                  ><el-checkbox v-model="clearKey">清除已保存密钥</el-checkbox></el-form-item
                >
                <el-form-item label="模型列表">
                  <div class="model-picker-row">
                    <el-select
                      v-model="selectedModels"
                      aria-label="模型列表"
                      multiple
                      filterable
                      clearable
                      collapse-tags
                      collapse-tags-tooltip
                      :max-collapse-tags="2"
                      :multiple-limit="50"
                      :loading="fetchingModels"
                      placeholder="选择或搜索模型"
                      :no-data-text="discovered ? '暂无可选模型' : '请先获取模型'"
                      no-match-text="没有匹配的模型"
                    >
                      <el-option
                        v-for="model in modelOptions"
                        :key="model.id"
                        :value="model.id"
                        :label="model.name === model.id ? model.id : `${model.id} · ${model.name}`"
                      />
                    </el-select>
                    <el-button
                      :loading="fetchingModels"
                      :disabled="busy || !baseUrl.trim()"
                      @click="fetchModels"
                      >获取</el-button
                    >
                  </div>
                </el-form-item>
                <el-alert
                  v-if="discoveryError"
                  :title="discoveryError"
                  type="error"
                  :closable="false"
                />
                <el-alert
                  v-else-if="discovered?.truncated"
                  title="列表未完整返回，可使用自定义模型补充。"
                  type="warning"
                  :closable="false"
                />
                <el-form-item label="自定义模型">
                  <el-input
                    aria-label="自定义模型"
                    type="textarea"
                    v-model="models"
                    :rows="3"
                    maxlength="10050"
                    placeholder="每行一个模型 ID"
                  />
                </el-form-item>
                <el-button type="primary" native-type="submit">保存提供商</el-button>
                <el-button
                  v-if="editing"
                  native-type="button"
                  :disabled="settings.defaultModel?.providerId === editing"
                  @click="remove"
                  >删除提供商</el-button
                >
                <p v-if="settings.defaultModel?.providerId === editing">
                  移除默认模型或删除此提供商前，请先切换全局默认模型。
                </p>
              </fieldset>
            </el-form>
            <el-form label-position="top" :disabled="busy" v-if="current" @submit.prevent="test">
              <label for="test-model">连接测试模型</label>
              <el-select id="test-model" v-model="testModel" :disabled="busy"
                ><el-option
                  v-for="model in current.models"
                  :key="model"
                  :value="model"
                  :label="model"
              /></el-select>
              <el-button :disabled="busy || dirty || !testModel" native-type="submit"
                >测试已保存配置</el-button
              >
              <p>连接测试只测试所选模型，不改变默认模型；会发送短消息，可能产生少量调用费用。</p>
            </el-form>
          </div></el-drawer
        >
      </template>
    </section>
  </div>
</template>

<style scoped>
.model-picker-row {
  display: flex;
  gap: 8px;
  width: 100%;
  align-items: flex-start;
}
.model-picker-row .el-select {
  flex: 1;
  min-width: 0;
}
.model-picker-row .el-button {
  flex-shrink: 0;
}
</style>
