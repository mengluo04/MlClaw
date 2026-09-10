<script setup lang="ts">
import { useDirtyGuard } from "../composables/dirty";
import { confirmAction } from "../composables/confirm";
import { computed, onMounted, ref } from "vue";
import type { ModelProvider, ModelSettings } from "@mlclaw/shared";
import { api, ApiError } from "../api";

const emit = defineEmits<{ expired: []; saved: [label: string] }>();
const settings = ref<ModelSettings>({ providers: [], defaultModel: null });
const busy = ref(false);
const loaded = ref(false);
const notice = ref("");
const editorOpen = ref(false);
const editing = ref("");
const name = ref("");
const baseUrl = ref("");
const models = ref("");
const apiKey = ref("");
const clearKey = ref(false);
const original = ref("");
const defaultChoice = ref("");
const testModel = ref("");
const current = computed(() =>
  settings.value.providers.find((provider) => provider.id === editing.value),
);
const draft = () => JSON.stringify([name.value, baseUrl.value, models.value]);
const dirty = computed(
  () => draft() !== original.value || !!apiKey.value || clearKey.value,
);
const choices = computed(() =>
  settings.value.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: JSON.stringify({ providerId: provider.id, model }),
      label: `${provider.name} / ${model}`,
    })),
  ),
);
const savedDefault = computed(() =>
  settings.value.defaultModel
    ? JSON.stringify(settings.value.defaultModel)
    : "",
);
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  notice.value = "";
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) emit("expired");
    notice.value = error instanceof Error ? error.message : "操作失败，请重试";
  } finally {
    busy.value = false;
  }
}
async function load() {
  settings.value = await api<ModelSettings>("/settings/models");
  loaded.value = true;
  defaultChoice.value = savedDefault.value;
  emit(
    "saved",
    choices.value.find((choice) => choice.value === savedDefault.value)
      ?.label ?? "尚未指定",
  );
}
async function edit(provider?: ModelProvider, force = false) {
  if (
    !force &&
    dirty.value &&
    !(await confirmAction("切换提供商将丢弃未保存的修改，是否继续？"))
  )
    return;
  editorOpen.value = true;
  editing.value = provider?.id ?? "";
  name.value = provider?.name ?? "";
  baseUrl.value = provider?.baseUrl ?? "";
  models.value = provider?.models.join("\n") ?? "";
  apiKey.value = "";
  clearKey.value = false;
  testModel.value = provider?.models[0] ?? "";
  original.value = draft();
}
async function save() {
  await action(async () => {
    const result = await api<{ id: string }>(
      editing.value
        ? `/settings/providers/${editing.value}`
        : "/settings/providers",
      editing.value ? "PUT" : "POST",
      {
        name: name.value,
        baseUrl: baseUrl.value,
        models: models.value
          .split("\n")
          .map((model) => model.trim())
          .filter(Boolean),
        ...(clearKey.value
          ? { apiKey: "" }
          : apiKey.value
            ? { apiKey: apiKey.value }
            : {}),
      },
    );
    await load();
    await edit(
      settings.value.providers.find((provider) => provider.id === result.id),
      true,
    );
    notice.value = "提供商配置已保存";
  });
}
async function remove() {
  if (!(await confirmAction("确定删除该提供商及其模型配置？"))) return;
  await action(async () => {
    await api(`/settings/providers/${editing.value}`, "DELETE");
    await load();
    await edit(undefined, true);
    editorOpen.value = false;
    notice.value = "提供商已删除";
  });
}
async function saveDefault() {
  await action(async () => {
    await api(
      "/settings/model-default",
      "PUT",
      JSON.parse(defaultChoice.value),
    );
    await load();
    notice.value = "全局默认模型已保存，后续所有新任务统一使用该模型";
  });
}
async function test() {
  await action(async () => {
    await api(`/settings/providers/${editing.value}/test`, "POST", {
      model: testModel.value,
    });
    notice.value = "模型连接成功";
  });
}
original.value = draft();
onMounted(() => action(load));

const pageDirty = computed(
  () =>
    (editorOpen.value && dirty.value) ||
    defaultChoice.value !== savedDefault.value,
);
useDirtyGuard(pageDirty);
async function closeEditor(done: () => void) {
  if (!dirty.value || (await confirmAction("放弃尚未保存的提供商配置？"))) {
    apiKey.value = "";
    clearKey.value = false;
    original.value = draft();
    done();
  }
}
</script>

<template>
  <section class="settings-panel">
    <h2>模型设置</h2>
    <p role="status">{{ notice }}</p>
    <p v-if="busy">正在处理…</p>
    <el-button
      v-if="!loaded && !busy"
      @click="action(load)"
      native-type="submit"
      >重新加载模型配置</el-button
    >
    <template v-if="loaded">
      <p>
        所有对话和后续任务统一使用全局默认模型；运行中的任务保留启动时的配置。
      </p>
      <p v-if="!settings.providers.length">
        尚未配置提供商，请先添加提供商及模型，再指定全局默认模型。
      </p>
      <el-form
        label-position="top"
        :disabled="busy"
        @submit.prevent="saveDefault"
      >
        <label for="global-model">全局默认模型</label>
        <el-select
          id="global-model"
          v-model="defaultChoice"
          :disabled="busy || !choices.length"
        >
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
      <el-table
        class="desktop-data"
        :data="settings.providers"
        empty-text="尚未添加提供商"
        ><el-table-column
          prop="name"
          label="名称"
          min-width="130"
        /><el-table-column label="模型" min-width="200"
          ><template #default="{ row }">{{
            row.models.join("、")
          }}</template></el-table-column
        ><el-table-column label="密钥" width="95"
          ><template #default="{ row }"
            ><el-tag :type="row.hasApiKey ? 'success' : 'info'">{{
              row.hasApiKey ? "已配置" : "未配置"
            }}</el-tag></template
          ></el-table-column
        ><el-table-column label="操作" width="80"
          ><template #default="{ row }"
            ><el-button
              text
              @click="
                edit(settings.providers.find((item) => item.id === row.id))
              "
              >编辑</el-button
            ></template
          ></el-table-column
        ></el-table
      >
      <div class="mobile-data">
        <el-card
          v-for="provider in settings.providers"
          :key="provider.id"
          shadow="never"
        >
          <h3>{{ provider.name }}</h3>
          <p>{{ provider.models.join("、") }}</p>
          <p>密钥：{{ provider.hasApiKey ? "已配置" : "未配置" }}</p>
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
          <el-alert
            v-if="notice"
            :title="notice"
            type="info"
            :closable="false"
          />
          <el-form label-position="top" :disabled="busy" @submit.prevent="save">
            <h3>{{ editing ? "编辑提供商" : "新增提供商" }}</h3>
            <p v-if="dirty">提供商配置有未保存的修改。</p>
            <fieldset :disabled="busy">
              <el-form-item
                ><template #label>提供商名称</template
                ><el-input
                  aria-label="提供商名称"
                  v-model="name"
                  required
                  maxlength="100"
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
                ><template #label>模型列表</template
                ><el-input
                  aria-label="模型列表"
                  type="textarea"
                  v-model="models"
                  :rows="4"
                  required
                  maxlength="10050"
                  placeholder="每行一个模型标识，填写服务商实际支持的名称"
              /></el-form-item>
              <p>
                支持 Chat Completions 兼容接口；每个提供商最多 50
                个模型，共用该提供商的地址和密钥。
              </p>
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
                    current?.hasApiKey
                      ? '已保存，留空保留；地址改变则清除'
                      : '尚未保存密钥'
                  "
              /></el-form-item>
              <el-form-item
                ><el-checkbox v-model="clearKey"
                  >清除已保存密钥</el-checkbox
                ></el-form-item
              >
              <el-button type="primary" native-type="submit"
                >保存提供商</el-button
              >
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
          <el-form
            label-position="top"
            :disabled="busy"
            v-if="current"
            @submit.prevent="test"
          >
            <label for="test-model">连接测试模型</label>
            <el-select id="test-model" v-model="testModel" :disabled="busy"
              ><el-option
                v-for="model in current.models"
                :key="model"
                :value="model"
                :label="model"
            /></el-select>
            <el-button
              :disabled="busy || dirty || !testModel"
              native-type="submit"
              >测试已保存配置</el-button
            >
            <p>
              连接测试只测试所选模型，不改变默认模型；会发送短消息，可能产生少量调用费用。
            </p>
          </el-form>
        </div></el-drawer
      >
    </template>
  </section>
</template>
