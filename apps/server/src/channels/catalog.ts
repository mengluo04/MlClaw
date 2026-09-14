import type { ChannelKind } from '@mlclaw/shared';

export const channelNames: Record<ChannelKind, string> = {
  qq: 'QQ',
  weixin: '微信',
  webhook: 'Webhook',
  email: '邮箱',
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  dingtalk: '钉钉',
  feishu: '飞书',
  wecom: 'WeCom Bot',
};
export const isOutboundOnly = (kind: ChannelKind) =>
  kind === 'webhook' || kind === 'email' || kind === 'wecom';
