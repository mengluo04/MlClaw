<script setup lang="ts">
import { useDirtyGuard } from "../composables/dirty";
import { confirmAction } from "../composables/confirm";
import { computed, onMounted, onUnmounted, ref } from "vue";
import type {
  ChannelAccountView,
  ChannelSettings,
  WeixinLoginView,
} from "@mlclaw/shared";
import { api, ApiError } from "../api";

const emit = defineEmits<{ expired: []; open: [conversationId: string] }>();
const settings = ref<ChannelSettings>({ accounts: [], deliveries: [] });
const loaded = ref(false);
const busy = ref(false);
const notice = ref("");
const error = ref("");
const appId = ref("");
const appSecret = ref("");
const login = ref<WeixinLoginView | null>(null);
const verifyCode = ref("");
const pairing = ref<{
  accountId: string;
  code: string;
  expiresAt: string;
  deadline: number;
} | null>(null);
const qq = computed(() =>
  settings.value.accounts.find((account) => account.kind === "qq"),
);
const weixin = computed(() =>
  settings.value.accounts.find((account) => account.kind === "weixin"),
);
const dirty = computed(
  () =>
    loaded.value &&
    (!!appSecret.value || appId.value !== (qq.value?.remoteId ?? "")),
);
useDirtyGuard(dirty);
const loggingIn = computed(
  () =>
    login.value &&
    !["confirmed", "expired", "error"].includes(login.value.state),
);
const stateLabels = {
  stopped: "已停止",
  connecting: "正在连接",
  connected: "已连接",
  error: "连接异常",
  expired: "登录已失效",
};
const deliveryLabels: Record<string, string> = {
  pending: "等待发送",
  sending: "发送中",
  sent: "平台已确认发送",
  unknown: "结果未确认",
  failed: "发送失败",
  cancelled: "已取消",
};
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;
let refreshing = false;
function fail(reason: unknown) {
  if (!alive) return;
  if (reason instanceof ApiError && reason.status === 401) emit("expired");
  error.value =
    reason instanceof Error ? reason.message : "渠道操作失败，请重试";
}
async function load() {
  const result = await api<ChannelSettings>("/channels");
  if (!alive) return;
  settings.value = result;
  loaded.value = true;
  if (
    pairing.value &&
    (pairing.value.deadline <= Date.now() ||
      result.accounts.find((a) => a.id === pairing.value?.accountId)
        ?.pairedSender)
  )
    pairing.value = null;
}
async function action(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  notice.value = "";
  error.value = "";
  try {
    await operation();
    await load();
  } catch (reason) {
    fail(reason);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  if (!alive || refreshing) return;
  refreshing = true;
  try {
    if (!busy.value) {
      await load();
      const active = await api<WeixinLoginView | null>(
        "/channels/weixin/login",
      );
      if (alive) login.value = active;
    }
  } catch (reason) {
    fail(reason);
  } finally {
    refreshing = false;
    if (alive)
      timer = setTimeout(() => {
        void refresh();
      }, 3000);
  }
}
async function saveQQ() {
  await action(async () => {
    await api("/channels/qq", "PUT", {
      appId: appId.value.trim(),
      ...(appSecret.value ? { appSecret: appSecret.value } : {}),
    });
    appSecret.value = "";
    notice.value = "QQ 配置已保存，请连接后生成身份绑定码";
  });
}
async function toggle(account: ChannelAccountView, enabled: boolean) {
  await action(async () => {
    await api(`/channels/${account.id}/state`, "POST", { enabled });
    notice.value = enabled ? "已开始连接，请查看状态" : "渠道已停止";
  });
}
async function bind(account: ChannelAccountView) {
  await action(async () => {
    const result = await api<{
      code: string;
      expiresAt: string;
      expiresInSeconds: number;
    }>(`/channels/${account.id}/pairing`, "POST");
    pairing.value = {
      accountId: account.id,
      ...result,
      deadline: Date.now() + result.expiresInSeconds * 1000,
    };
  });
}
async function unbind(account: ChannelAccountView) {
  if (
    !(await confirmAction(
      "解除身份绑定会停止渠道并取消该渠道运行中的任务，是否继续？",
    ))
  )
    return;
  await action(async () => {
    await api(`/channels/${account.id}/pairing`, "DELETE");
    pairing.value = null;
    notice.value = "已解除绑定，重新连接后可绑定新身份";
  });
}
async function remove(account: ChannelAccountView) {
  if (
    !(await confirmAction(
      "移除渠道将清除本机渠道凭据、身份绑定和投递记录，并停止该渠道任务；网页会话历史保留。是否继续？",
    ))
  )
    return;
  await action(async () => {
    await api(`/channels/${account.id}`, "DELETE");
    if (account.kind === "qq") {
      appId.value = "";
      appSecret.value = "";
    }
    pairing.value = null;
    notice.value = "渠道已移除；如需撤销平台授权，请同时在平台管理连接";
  });
}
async function startLogin() {
  await action(async () => {
    login.value = await api<WeixinLoginView>("/channels/weixin/login", "POST");
    verifyCode.value = "";
  });
}
async function cancelLogin() {
  const id = login.value?.id;
  if (id)
    await action(async () => {
      await api(`/channels/weixin/login/${id}`, "DELETE");
      login.value = null;
    });
}
async function verify() {
  const id = login.value?.id;
  if (id)
    await action(async () => {
      await api(`/channels/weixin/login/${id}/verify`, "POST", {
        code: verifyCode.value,
      });
      verifyCode.value = "";
      notice.value = "验证码已提交，请等待微信确认";
    });
}
onMounted(async () => {
  await action(async () => {
    await load();
    appId.value = qq.value?.remoteId ?? "";
    login.value = await api<WeixinLoginView | null>("/channels/weixin/login");
  });
  if (alive)
    timer = setTimeout(() => {
      void refresh();
    }, 3000);
});
onUnmounted(() => {
  alive = false;
  clearTimeout(timer);
});
</script>

<template>
  <section aria-label="消息渠道">
    <section class="settings-panel">
      <h2>消息渠道 · QQ / 微信</h2>
      <p>
        连接机器人后，在这里生成绑定码，再由本人发送给机器人。当前支持私聊文本；发送
        /stop 可取消当前渠道任务。
      </p>
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
      <el-alert
        v-if="notice"
        :title="notice"
        type="info"
        :closable="false"
        show-icon
      />
      <el-button :disabled="busy" @click="action(load)" native-type="submit"
        >刷新渠道状态</el-button
      >
      <p v-if="!loaded">正在读取渠道配置…</p>
      <p v-else-if="!settings.accounts.length">
        还没有连接渠道，请配置 QQ 机器人或使用微信扫码。
      </p>
      <el-steps
        :active="
          settings.accounts.some((item) => item.pairedSender)
            ? 3
            : settings.accounts.some((item) => item.state === 'connected')
              ? 2
              : settings.accounts.length
                ? 1
                : 0
        "
        finish-status="success"
        simple
        ><el-step title="配置账号" /><el-step title="连接渠道" /><el-step
          title="绑定本人"
      /></el-steps>
      <div class="channel-grid">
        <article aria-label="QQ 机器人配置">
          <h3>QQ 机器人</h3>
          <p>
            在 QQ 开放平台创建机器人，填写应用凭据。已有配置留空密钥可保留同一
            AppID 的凭据。
          </p>
          <el-form
            label-position="top"
            :disabled="busy"
            @submit.prevent="saveQQ"
          >
            <el-form-item
              ><template #label>QQ AppID</template
              ><el-input
                aria-label="QQ AppID"
                v-model="appId"
                required
                pattern="[0-9]{1,32}"
                maxlength="32"
                :disabled="busy"
            /></el-form-item>
            <el-form-item
              ><template #label>QQ AppSecret</template
              ><el-input
                aria-label="QQ AppSecret"
                v-model="appSecret"
                type="password"
                autocomplete="new-password"
                maxlength="4096"
                :required="!qq || appId !== qq.remoteId"
                :disabled="busy"
            /></el-form-item>
            <el-button type="primary" :disabled="busy" native-type="submit"
              >保存 QQ 配置</el-button
            >
          </el-form>
        </article>
        <article aria-label="微信机器人配置">
          <h3>微信机器人</h3>
          <p>使用微信扫描二维码并确认连接；如手机显示验证码，在下方填写。</p>
          <el-button
            :disabled="busy || !!loggingIn"
            @click="startLogin"
            native-type="submit"
            >{{ weixin ? "重新扫码连接微信" : "微信扫码连接" }}</el-button
          >
          <template v-if="login">
            <p role="status">{{ login.message }}</p>
            <img
              v-if="login.qrDataUrl"
              class="channel-qr"
              :src="login.qrDataUrl"
              alt="微信机器人连接二维码"
              width="280"
              height="280"
            />
            <p v-if="loggingIn">有效期至 {{ login.expiresAt }}</p>
            <el-form
              label-position="top"
              :disabled="busy"
              v-if="login.state === 'need_verifycode'"
              @submit.prevent="verify"
            >
              <el-form-item
                ><template #label>微信验证码</template
                ><el-input
                  aria-label="微信验证码"
                  v-model="verifyCode"
                  inputmode="numeric"
                  pattern="[0-9]{1,12}"
                  maxlength="12"
                  autocomplete="one-time-code"
                  required
              /></el-form-item>
              <el-button :disabled="busy" native-type="submit"
                >提交微信验证码</el-button
              >
            </el-form>
            <el-button
              :disabled="busy"
              @click="cancelLogin"
              native-type="submit"
              >关闭扫码会话</el-button
            >
          </template>
        </article>
      </div>
      <article
        v-for="account in settings.accounts"
        :key="account.id"
        :aria-label="`${account.kind === 'qq' ? 'QQ' : '微信'}渠道状态`"
      >
        <h3>
          {{ account.kind === "qq" ? "QQ" : "微信" }} ·
          {{ stateLabels[account.state] }}
        </h3>
        <p>
          机器人标识：{{ account.remoteId }} · 凭据{{
            account.hasCredential ? "已保存" : "未配置"
          }}
        </p>
        <p v-if="account.message">{{ account.message }}</p>
        <p>
          {{
            account.pairedSender
              ? `已绑定身份：${account.pairedSender}`
              : "尚未绑定身份，普通消息不会交给助手"
          }}
        </p>
        <el-button
          :disabled="busy || (account.kind === 'weixin' && !!loggingIn)"
          @click="toggle(account, true)"
          native-type="submit"
          >{{ account.enabled ? "重新连接" : "连接渠道" }}</el-button
        >
        <el-button
          :disabled="busy || !account.enabled"
          @click="toggle(account, false)"
          native-type="submit"
          >停止渠道</el-button
        >
        <el-button
          v-if="!account.pairedSender"
          :disabled="busy || !account.enabled"
          @click="bind(account)"
          native-type="submit"
          >生成{{ account.kind === "qq" ? "QQ" : "微信" }}绑定码</el-button
        >
        <el-button
          v-else
          :disabled="busy"
          @click="unbind(account)"
          native-type="submit"
          >解除身份绑定</el-button
        >
        <el-button
          :disabled="busy || (account.kind === 'weixin' && !!loggingIn)"
          @click="remove(account)"
          native-type="submit"
          >移除渠道</el-button
        >
        <div v-if="pairing?.accountId === account.id" role="status">
          <p>请用本人账号向该机器人发送（5 分钟内有效）：</p>
          <pre>/bind {{ pairing.code }}</pre>
          <p>绑定后请重新发送你的问题。</p>
        </div>
      </article>
      <h3>最近回复投递</h3>
      <p v-if="!settings.deliveries.length">暂无投递记录。</p>
      <p>
        未确认的发送不会自动重发，避免重复消息；可在原聊天核对，并在网页查看完整回复。工具批准仍需在对应网页会话完成。
      </p>
      <article v-for="delivery in settings.deliveries" :key="delivery.id">
        <p>
          {{ delivery.kind === "qq" ? "QQ" : "微信" }} ·
          {{ deliveryLabels[delivery.status] ?? delivery.status }} ·
          {{ delivery.createdAt }}
        </p>
        <p v-if="delivery.error">{{ delivery.error }}</p>
        <el-button
          v-if="delivery.conversationId"
          :disabled="busy"
          @click="emit('open', delivery.conversationId)"
          native-type="submit"
          >打开对应会话</el-button
        >
      </article>
    </section>
  </section>
</template>
