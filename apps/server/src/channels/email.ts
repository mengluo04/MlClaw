import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { isIP, connect, type Socket } from 'node:net';
import type { EmailConfig, EmailConfigInput } from '@mlclaw/shared';
import {
  ChannelError,
  DeliveryError,
  type ChannelAccount,
  type ChannelSink,
  type ChannelTransport,
  type OutboundMessage,
} from './types.js';

export function validateEmailConfig(input: EmailConfigInput): EmailConfig {
  const { host, port, security, username, from, to } = input;
  const address =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
  if (
    typeof host !== 'string' ||
    host.length > 253 ||
    !(isIP(host) || /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !['tls', 'starttls'].includes(security) ||
    typeof username !== 'string' ||
    !username.trim() ||
    username.length > 320 ||
    /[\x00-\x1f\x7f]/.test(username) ||
    [from, to].some(
      (value) => typeof value !== 'string' || value.length > 320 || !address.test(value),
    )
  )
    throw new ChannelError('请填写有效的 SMTP 主机、端口、加密方式、账号和单个邮箱地址');
  return { host: host.toLowerCase(), port, security, username, from, to };
}

/** 仅发送管理员配置的固定收件地址；不读取邮件，不采纳任务中的地址。 */
export class EmailTransport implements ChannelTransport {
  constructor(
    private account: ChannelAccount,
    private sink: ChannelSink,
  ) {}

  async run(signal: AbortSignal) {
    if (signal.aborted) return;
    this.sink.state('connected', '已启用；SMTP 接受不代表送达或已读，投递状态见执行历史');
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  }

  async send(message: OutboundMessage, signal: AbortSignal) {
    const config = this.account.email;
    if (
      !config ||
      signal.aborted ||
      !message.proactive ||
      message.senderId !== 'email' ||
      Array.from(message.text).length > 100000
    )
      throw new DeliveryError('failed');
    const controller = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    let socket: Socket | undefined;
    const transport = nodemailer.createTransport({
      // Nodemailer 非池化 close 不会关闭正在发送的连接，显式持有 socket 以支持取消。
      getSocket: (_options, callback) => {
        if (controller.aborted) {
          callback(new DeliveryError('failed'));
          return;
        }
        const connection = connect({ host: config.host, port: config.port, signal: controller });
        socket = connection;
        const failed = (error: Error) => callback(error);
        connection.once('error', failed);
        connection.once('connect', () => {
          connection.removeListener('error', failed);
          if (controller.aborted) {
            connection.destroy();
            callback(new DeliveryError('failed'));
            return;
          }
          callback(null, { connection });
        });
      },
      host: config.host,
      port: config.port,
      secure: config.security === 'tls',
      requireTLS: config.security === 'starttls',
      auth: { user: config.username, pass: this.account.secret },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    let abort: () => void = () => {};
    try {
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => {
          socket?.destroy();
          transport.close();
          reject(new DeliveryError('unknown'));
        };
        controller.addEventListener('abort', abort, { once: true });
        if (controller.aborted) abort();
      });
      const escaped = message.text.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
      );
      const info = await Promise.race([
        interrupted,
        transport.sendMail({
          from: { address: config.from, name: 'MlClaw' },
          to: [{ address: config.to, name: '' }],
          envelope: { from: config.from, to: [config.to] },
          subject: 'MlClaw 定时任务结果',
          text: message.text,
          html: `<div style="white-space:pre-wrap;overflow-wrap:anywhere">${escaped}</div>`,
          messageId: `<${createHash('sha256')
            .update(this.account.id + ':' + message.id)
            .digest('hex')}@mlclaw.local>`,
          headers: { 'Auto-Submitted': 'auto-generated' },
        }),
      ]);
      if (!info.accepted.length || info.rejected.length) throw new DeliveryError('failed');
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      const responseCode =
        error && typeof error === 'object' && 'responseCode' in error ? error.responseCode : 0;
      throw new DeliveryError(
        ['EAUTH', 'EENVELOPE', 'EDNS', 'ECONNECTION'].includes(String(code)) ||
          (typeof responseCode === 'number' && responseCode >= 400)
          ? 'failed'
          : 'unknown',
      );
    } finally {
      controller.removeEventListener('abort', abort);
      socket?.destroy();
      transport.close();
    }
  }
}
