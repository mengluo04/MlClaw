<script setup lang="ts">
import { useSession } from '../stores/session';
import { useDirtyGuard } from '../composables/dirty';
import { confirmAction } from '../composables/confirm';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type {
  ChannelAccountView,
  EmailConfig,
  ChannelSettings,
  WeixinLoginView,
  WebhookMethod,
} from '@mlclaw/shared';
import { api, ApiError } from '../api';

/** 当前用户的登录与助手状态。 */
const session = useSession();
/** 当前功能设置。 */
const settings = ref<ChannelSettings>({ accounts: [] });
/** 是否已完成首次数据加载。 */
const loaded = ref(false);
/** 操作进行中标记，用于禁用重复提交。 */
const busy = ref(false);
/** 当前操作反馈文案。 */
const notice = ref('');
/** 当前错误提示。 */
const error = ref('');
/** QQ 机器人应用标识。 */
const appId = ref('');
/** QQ 机器人应用密钥输入。 */
const appSecret = ref('');
/** 待保存的 Webhook 推送地址。 */
const webhookUrl = ref('');
/** 请求方式、Header 草稿与请求体模板。 */
const webhookMethod = ref<WebhookMethod>('POST');
const webhookHeaders = ref<Array<{ name: string; value: string; savedName?: string }>>([]);
const webhookBody = ref('');
/** 已加载草稿快照，轮询不覆盖未保存的编辑。 */
const webhookBaseline = ref('');
const webhookDraft = computed(() =>
  JSON.stringify([webhookUrl.value, webhookMethod.value, webhookHeaders.value, webhookBody.value]),
);
const webhookDirty = computed(() => webhookDraft.value !== webhookBaseline.value);
/** 加载已保存配置，Header 值不回显。 */
const resetWebhook = () => {
  const config = webhook.value?.webhook;
  webhookUrl.value = '';
  webhookMethod.value = config?.method ?? 'POST';
  webhookHeaders.value = config
    ? config.headerNames.map((name) => ({ name, value: '', savedName: name }))
    : [{ name: 'content-type', value: 'application/json' }];
  webhookBody.value =
    config?.bodyTemplate ?? '{"id":"{{id}}","type":"schedule.result","text":"{{text}}"}';
  webhookBaseline.value = webhookDraft.value;
};
const email = computed(() => settings.value.accounts.find((account) => account.kind === 'email'));
const emailDraft = ref<EmailConfig>({
  host: '',
  port: 465,
  security: 'tls',
  username: '',
  from: '',
  to: '',
});
const emailPassword = ref('');
const emailBaseline = ref('');
const emailDirty = computed(
  () => JSON.stringify(emailDraft.value) !== emailBaseline.value || !!emailPassword.value,
);
const resetEmail = () => {
  emailDraft.value = email.value?.email
    ? { ...email.value.email }
    : { host: '', port: 465, security: 'tls', username: '', from: '', to: '' };
  emailPassword.value = '';
  emailBaseline.value = JSON.stringify(emailDraft.value);
};
const saveEmail = () =>
  action(async () => {
    await api('/channels/email', 'PUT', {
      ...emailDraft.value,
      ...(emailPassword.value ? { password: emailPassword.value } : {}),
    });
    await load();
    resetEmail();
    notice.value = '邮箱配置已保存，请启用渠道，并在定时任务中重新选择邮箱；可手动运行计划验证投递';
  });
/** 当前微信扫码登录状态与二维码信息。 */
const login = ref<WeixinLoginView | null>(null);
/** 微信扫码登录要求补充的验证码。 */
const verifyCode = ref('');
/** 渠道本人身份的绑定状态。 */
const pairing = ref<{
  accountId: string;
  code: string;
  expiresAt: string;
  deadline: number;
} | null>(null);
/** QQ 渠道配置。 */
const qq = computed(() => settings.value.accounts.find((account) => account.kind === 'qq'));
/** 微信渠道配置。 */
const weixin = computed(() => settings.value.accounts.find((account) => account.kind === 'weixin'));
/** Webhook 渠道配置。 */
const webhook = computed(() =>
  settings.value.accounts.find((account) => account.kind === 'webhook'),
);
/** 当前草稿是否偏离已保存内容。 */
const dirty = computed(
  () =>
    loaded.value &&
    (!!appSecret.value ||
      appId.value !== (qq.value?.remoteId ?? '') ||
      webhookDirty.value ||
      emailDirty.value),
);
useDirtyGuard(dirty);
/** 是否正在提交登录。 */
const loggingIn = computed(
  () => login.value && !['confirmed', 'expired', 'error'].includes(login.value.state),
);
/** 运行状态对应的中文标签。 */
const stateLabels = {
  stopped: '已停止',
  connecting: '正在连接',
  connected: '已连接',
  error: '连接异常',
  expired: '登录已失效',
};
/** 延迟执行或超时控制的定时器句柄。 */
let timer: ReturnType<typeof setTimeout> | undefined;
/** 组件是否仍挂载，防止卸载后的异步回调更新状态。 */
let alive = true;
/** 是否正在刷新数据。 */
let refreshing = false;
/** 将异常转换为当前流程的失败状态或用户反馈。 */
const fail = (reason: unknown) => {
  if (!alive) return;
  if (reason instanceof ApiError && reason.status === 401) session.clear();
  error.value = reason instanceof Error ? reason.message : '渠道操作失败，请重试';
};
/** 加载当前页面或业务所需的数据。 */
const load = async () => {
  /** 接口 /channels 返回的业务数据。 */
  const result = await api<ChannelSettings>('/channels');
  if (!alive) return;
  const syncWebhook = !loaded.value || !webhookDirty.value;
  const syncEmail = !loaded.value || !emailDirty.value;
  settings.value = result;
  if (syncEmail) resetEmail();
  if (syncWebhook) resetWebhook();
  loaded.value = true;
  if (
    pairing.value &&
    (pairing.value.deadline <= Date.now() ||
      result.accounts.find((a) => a.id === pairing.value?.accountId)?.pairedSender)
  )
    pairing.value = null;
};
/** 统一处理操作期间的忙碌状态与错误反馈。 */
const action = async (operation: () => Promise<void>) => {
  if (busy.value) return;
  busy.value = true;
  notice.value = '';
  error.value = '';
  try {
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
  if (!alive || refreshing) return;
  refreshing = true;
  try {
    if (!busy.value) {
      await load();
      /** 是否存在活动中的任务或对象。 */
      const active = await api<WeixinLoginView | null>('/channels/weixin/login');
      if (alive) login.value = active;
    }
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ reason) {
    fail(reason);
  } finally {
    refreshing = false;
    if (alive)
      timer = setTimeout(() => {
        void refresh();
      }, 3000);
  }
};
/** 保存 QQ 渠道连接配置。 */
const saveQQ = async () => {
  await action(async () => {
    await api('/channels/qq', 'PUT', {
      appId: appId.value.trim(),
      ...(appSecret.value ? { appSecret: appSecret.value } : {}),
    });
    appSecret.value = '';
    notice.value = 'QQ 配置已保存，请连接后生成身份绑定码';
  });
};
/** 保存完整请求配置，空的已保存 Header 值表示保留。 */
const saveWebhook = async () => {
  await action(async () => {
    const headers: Record<string, string | null> = Object.create(null);
    for (const row of webhookHeaders.value) {
      const name = row.name.trim().toLowerCase();
      if (!name || Object.hasOwn(headers, name)) throw new Error('请填写 Header 名称，且不能重复');
      headers[name] = !row.value && row.savedName === name ? null : row.value;
    }
    await api('/channels/webhook', 'PUT', {
      ...(webhookUrl.value.trim() ? { url: webhookUrl.value.trim() } : {}),
      method: webhookMethod.value,
      headers,
      bodyTemplate: webhookBody.value,
    });
    await load();
    resetWebhook();
    notice.value = 'Webhook 配置已保存，请启用渠道，并在定时任务中重新选择该渠道';
  });
};
/** 切换记录的启用状态。 */
const toggle = async (account: ChannelAccountView, enabled: boolean) => {
  await action(async () => {
    await api(`/channels/${account.id}/state`, 'POST', { enabled });
    notice.value = enabled ? '已开始连接，请查看状态' : '渠道已停止';
  });
};
/** 绑定当前用户与渠道发送者身份。 */
const bind = async (account: ChannelAccountView) => {
  await action(async () => {
    /** 接口 /channels/${account.id}/pairing 返回的业务数据。 */
    const result = await api<{
      code: string;
      expiresAt: string;
      expiresInSeconds: number;
    }>(`/channels/${account.id}/pairing`, 'POST');
    pairing.value = {
      accountId: account.id,
      ...result,
      deadline: Date.now() + result.expiresInSeconds * 1000,
    };
  });
};
/** 解除当前渠道的本人身份绑定。 */
const unbind = async (account: ChannelAccountView) => {
  if (!(await confirmAction('解除身份绑定会停止渠道并取消该渠道运行中的任务，是否继续？'))) return;
  await action(async () => {
    await api(`/channels/${account.id}/pairing`, 'DELETE');
    pairing.value = null;
    notice.value = '已解除绑定，重新连接后可绑定新身份';
  });
};
/** 删除指定记录并更新当前列表。 */
const remove = async (account: ChannelAccountView) => {
  if (
    !(await confirmAction(
      '移除渠道将清除本机渠道凭据、身份绑定和投递记录，并停止该渠道任务；网页会话历史保留。是否继续？',
    ))
  )
    return;
  await action(async () => {
    await api(`/channels/${account.id}`, 'DELETE');
    if (account.kind === 'webhook') {
      await load();
      resetWebhook();
    }
    if (account.kind === 'email') {
      await load();
      resetEmail();
    }
    if (account.kind === 'qq') {
      appId.value = '';
      appSecret.value = '';
    }
    pairing.value = null;
    notice.value = '渠道已移除；如需撤销平台授权，请同时在平台管理连接';
  });
};
/** 发起微信扫码登录并展示二维码。 */
const startLogin = async () => {
  await action(async () => {
    login.value = await api<WeixinLoginView>('/channels/weixin/login', 'POST');
    verifyCode.value = '';
  });
};
/** 取消正在进行的微信扫码登录。 */
const cancelLogin = async () => {
  /** 当前记录标识。 */
  const id = login.value?.id;
  if (id)
    await action(async () => {
      await api(`/channels/weixin/login/${id}`, 'DELETE');
      login.value = null;
    });
};
/** 验证当前凭据或绑定验证码。 */
const verify = async () => {
  /** 当前记录标识。 */
  const id = login.value?.id;
  if (id)
    await action(async () => {
      await api(`/channels/weixin/login/${id}/verify`, 'POST', {
        code: verifyCode.value,
      });
      verifyCode.value = '';
      notice.value = '验证码已提交，请等待微信确认';
    });
};
onMounted(async () => {
  await action(async () => {
    await load();
    appId.value = qq.value?.remoteId ?? '';
    login.value = await api<WeixinLoginView | null>('/channels/weixin/login');
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
  <div class="page-content feature-panel">
    <section aria-label="消息渠道">
      <section class="settings-panel">
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <el-alert v-if="notice" :title="notice" type="info" :closable="false" show-icon />
        <p v-if="!loaded">正在读取渠道配置…</p>
        <p v-else-if="!settings.accounts.length">
          还没有连接渠道，请配置 QQ、微信、邮箱或 Webhook。
        </p>
        <div class="channel-grid">
          <article
            v-for="channel in [
              { kind: 'webhook', label: 'Webhook 配置' },
              { kind: 'email', label: '邮箱配置' },
              { kind: 'qq', label: 'QQ 机器人配置' },
              { kind: 'weixin', label: '微信机器人配置' },
            ]"
            :key="channel.kind"
            :aria-label="channel.label"
          >
            <h3>
              {{
                channel.kind === 'email'
                  ? '邮箱'
                  : channel.kind === 'webhook'
                    ? 'Webhook'
                    : channel.kind === 'qq'
                      ? 'QQ 机器人'
                      : '微信机器人'
              }}
            </h3>
            <template v-if="channel.kind === 'webhook'">
              <p>
                按配置的 HTTP
                请求推送定时任务结果，无需身份绑定。可按接收端要求设置请求方式、Headers 和请求体。
              </p>
              <p>
                地址和 Header 值保存后不回显，留空保留；删除 Header
                行可移除该字段，更换地址需重新填写 Header
                值。每次保存会停止渠道并使计划中的旧投递授权失效。
              </p>
              <el-form
                label-position="top"
                :disabled="busy || !loaded"
                @submit.prevent="saveWebhook"
              >
                <el-form-item label="Webhook 地址">
                  <el-input
                    v-model="webhookUrl"
                    aria-label="Webhook 地址"
                    type="text"
                    autocomplete="off"
                    maxlength="4096"
                    :required="!webhook"
                    :placeholder="webhook ? '地址已保存，留空保留' : 'https://example.com/webhook'"
                  />
                </el-form-item>
                <el-form-item label="请求方式">
                  <el-select v-model="webhookMethod" aria-label="Webhook 请求方式">
                    <el-option
                      v-for="method in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']"
                      :key="method"
                      :label="method"
                      :value="method"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="Headers（请求头）">
                  <div class="webhook-headers">
                    <div
                      v-for="(header, index) in webhookHeaders"
                      :key="index"
                      class="webhook-header-row"
                    >
                      <el-input
                        v-model="header.name"
                        :aria-label="`Header 名称 ${index + 1}`"
                        placeholder="例如 Authorization"
                        maxlength="128"
                      />
                      <el-input
                        v-model="header.value"
                        :aria-label="`Header 值 ${index + 1}`"
                        type="text"
                        autocomplete="off"
                        :placeholder="
                          header.savedName === header.name.toLowerCase()
                            ? '已保存，留空保留'
                            : '例如 Bearer your-token'
                        "
                        maxlength="8192"
                      />
                      <el-button
                        :aria-label="`删除 Header ${index + 1}`"
                        native-type="button"
                        @click="webhookHeaders.splice(index, 1)"
                        >删除</el-button
                      >
                    </div>
                    <el-button
                      :disabled="webhookHeaders.length >= 32"
                      native-type="button"
                      @click="webhookHeaders.push({ name: '', value: '' })"
                      >添加 Header</el-button
                    >
                  </div>
                </el-form-item>
                <el-form-item label="请求体模板">
                  <el-input
                    v-model="webhookBody"
                    aria-label="Webhook 请求体模板"
                    type="textarea"
                    :rows="7"
                    maxlength="32768"
                    :disabled="webhookMethod === 'GET'"
                  />
                </el-form-item>
                <p v-if="webhookMethod === 'GET'">
                  GET 不发送请求体；模板保留，切换请求方式后可继续使用。
                </p>
                <p v-else v-pre>
                  支持 {{ text }}（任务结果）和 {{ id }}（投递 ID）。Content-Type 为
                  application/json 时，模板须为有效
                  JSON，变量写在字符串值内；其他类型按文本替换。留空不发送请求体。
                </p>
                <el-button
                  type="primary"
                  :disabled="busy || !loaded || (!webhook && !webhookUrl.trim())"
                  native-type="submit"
                  >保存 Webhook 配置</el-button
                >
              </el-form>
            </template>
            <template v-else-if="channel.kind === 'email'">
              <p>
                通过 SMTP 向固定邮箱发送定时任务结果，不接收邮件或聊天。正文最多 100,000
                字符，超长结果请到网页查看。
              </p>
              <p>
                密码或授权码保存后不回显，留空保留；更换 SMTP
                主机、端口、加密方式或账号须重新填写。保存后需重新启用并在计划中选择邮箱。
              </p>
              <el-form label-position="top" :disabled="busy || !loaded" @submit.prevent="saveEmail">
                <el-form-item label="SMTP 主机"
                  ><el-input
                    v-model="emailDraft.host"
                    aria-label="SMTP 主机"
                    placeholder="smtp.example.com"
                    required
                    maxlength="253"
                /></el-form-item>
                <el-form-item label="SMTP 端口"
                  ><el-input-number
                    v-model="emailDraft.port"
                    aria-label="SMTP 端口"
                    :min="1"
                    :max="65535"
                /></el-form-item>
                <el-form-item label="加密方式"
                  ><el-select v-model="emailDraft.security" aria-label="SMTP 加密方式"
                    ><el-option label="TLS（通常为 465 端口）" value="tls" /><el-option
                      label="STARTTLS（通常为 587 端口）"
                      value="starttls" /></el-select
                ></el-form-item>
                <el-form-item label="SMTP 账号"
                  ><el-input
                    v-model="emailDraft.username"
                    aria-label="SMTP 账号"
                    required
                    maxlength="320"
                    autocomplete="off"
                /></el-form-item>
                <el-form-item label="SMTP 密码或授权码"
                  ><el-input
                    v-model="emailPassword"
                    aria-label="SMTP 密码或授权码"
                    type="password"
                    autocomplete="new-password"
                    :required="!email"
                    maxlength="4096"
                    :placeholder="email ? '已保存，留空保留' : '填写邮箱服务提供的密码或授权码'"
                /></el-form-item>
                <el-form-item label="发件邮箱"
                  ><el-input
                    v-model="emailDraft.from"
                    aria-label="发件邮箱"
                    type="email"
                    required
                    maxlength="320"
                /></el-form-item>
                <el-form-item label="收件邮箱"
                  ><el-input
                    v-model="emailDraft.to"
                    aria-label="收件邮箱"
                    type="email"
                    required
                    maxlength="320"
                    placeholder="填写本人邮箱"
                /></el-form-item>
                <el-button type="primary" native-type="submit" :disabled="busy || !loaded"
                  >保存邮箱配置</el-button
                >
              </el-form>
            </template>
            <template v-else-if="channel.kind === 'qq'">
              <p>
                在 QQ 开放平台创建机器人，填写应用凭据。已有配置留空密钥可保留同一 AppID 的凭据。
              </p>
              <el-form label-position="top" :disabled="busy" @submit.prevent="saveQQ">
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
            </template>
            <template v-else>
              <p>使用微信扫描二维码并确认连接；如手机显示验证码，在下方填写。</p>
              <el-button :disabled="busy || !!loggingIn" @click="startLogin" native-type="submit">{{
                weixin ? '重新扫码连接微信' : '微信扫码连接'
              }}</el-button>
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
                  <el-button :disabled="busy" native-type="submit">提交微信验证码</el-button>
                </el-form>
                <el-button :disabled="busy" @click="cancelLogin" native-type="submit"
                  >关闭扫码会话</el-button
                >
              </template>
            </template>
            <section
              v-for="account in settings.accounts.filter((item) => item.kind === channel.kind)"
              :key="account.id"
              :aria-label="`${account.kind === 'email' ? '邮箱' : account.kind === 'qq' ? 'QQ' : account.kind === 'webhook' ? 'Webhook' : '微信'}渠道状态`"
            >
              <h3>
                {{
                  account.kind === 'email'
                    ? '邮箱'
                    : account.kind === 'qq'
                      ? 'QQ'
                      : account.kind === 'webhook'
                        ? 'Webhook'
                        : '微信'
                }}
                ·
                {{
                  (account.kind === 'webhook' || account.kind === 'email') &&
                  account.state === 'connected'
                    ? '已启用'
                    : stateLabels[account.state]
                }}
              </h3>
              <p v-if="account.kind !== 'webhook' && account.kind !== 'email'">
                机器人标识：{{ account.remoteId }} · 凭据{{
                  account.hasCredential ? '已保存' : '未配置'
                }}
              </p>
              <p v-else-if="account.kind === 'email'">
                收件邮箱：{{ account.email?.to }}；发送状态见定时任务执行历史。已发送表示 SMTP
                服务器已接受，不代表已送达或已读。
              </p>
              <p v-else>
                接收地址已保存 · {{ account.webhook?.method ?? 'POST' }} ·
                {{ account.webhook?.headerNames.length ?? 0 }} 个
                Header；定时投递状态请在执行历史查看。
              </p>
              <p v-if="account.message">{{ account.message }}</p>
              <p v-if="account.kind !== 'webhook' && account.kind !== 'email'">
                {{
                  account.pairedSender
                    ? `已绑定身份：${account.pairedSender}`
                    : '尚未绑定身份。连接机器人后，生成绑定码，再用本人账号发送给该机器人。'
                }}
              </p>
              <p
                v-if="
                  account.kind !== 'webhook' && account.kind !== 'email' && account.pairedSender
                "
              >
                当前支持私聊文本；向该机器人发送 /stop 可取消当前渠道任务。
              </p>
              <el-space wrap>
                <el-button :disabled="busy" @click="action(load)" native-type="button">
                  刷新状态
                </el-button>
                <el-button
                  :disabled="busy || (account.kind === 'weixin' && !!loggingIn)"
                  @click="toggle(account, true)"
                  native-type="submit"
                  >{{
                    account.kind === 'webhook' || account.kind === 'email'
                      ? account.enabled
                        ? '重新启用'
                        : '启用渠道'
                      : account.enabled
                        ? '重新连接'
                        : '连接渠道'
                  }}</el-button
                >
                <el-button
                  :disabled="busy || !account.enabled"
                  @click="toggle(account, false)"
                  native-type="submit"
                  >停止渠道</el-button
                >
                <el-button
                  v-if="
                    account.kind !== 'webhook' && account.kind !== 'email' && !account.pairedSender
                  "
                  :disabled="busy || !account.enabled"
                  @click="bind(account)"
                  native-type="submit"
                  >生成{{ account.kind === 'qq' ? 'QQ' : '微信' }}绑定码</el-button
                >
                <el-button
                  v-else-if="account.kind !== 'webhook' && account.kind !== 'email'"
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
              </el-space>
              <div v-if="pairing?.accountId === account.id" role="status">
                <p>请用本人账号向该机器人发送（5 分钟内有效）：</p>
                <pre>/bind {{ pairing.code }}</pre>
                <p>绑定后请重新发送你的问题。</p>
              </div>
            </section>
          </article>
        </div>
      </section>
    </section>
  </div>
</template>

<style scoped>
.webhook-headers {
  width: 100%;
  display: grid;
  gap: 12px;
}
.webhook-header-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
}
@media (max-width: 600px) {
  .webhook-header-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .webhook-header-row > :first-child {
    grid-column: 1 / -1;
  }
}
</style>
