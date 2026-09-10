import { formatSystemTime, parseSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { WeixinLoginView } from '@mlclaw/shared';
import { boundedString, ChannelError } from './types.js';
import { WeixinApi, weixinBase, WEIXIN_BASE } from './weixin.js';
import type { ChannelManager } from './manager.js';

interface LoginSession {
  userId: string; view: WeixinLoginView; controller: AbortController; run: Promise<void>;
  code: string; base: string; verifyCode?: string;
}
export class WeixinLogin {
  private sessions = new Map<string, LoginSession>();
  private starting = new Set<string>();
  private controller = new AbortController();
  constructor(private channels: ChannelManager, private api = new WeixinApi()) {}
  async start(userId: string) {
    if (this.controller.signal.aborted) throw new ChannelError('服务正在关闭', 503);
    if (this.starting.has(userId)) throw new ChannelError('二维码正在生成，请稍后重试', 409);
    const previous = this.sessions.get(userId);
    if (previous && !['confirmed', 'expired', 'error'].includes(previous.view.state) && parseSystemTime(previous.view.expiresAt) > Date.now()) throw new ChannelError('已有待扫码登录，请先取消或等待过期', 409);
    this.starting.add(userId);
    try {
      previous?.controller.abort(); await previous?.run;
      const result = await this.api.qr(AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]));
      const code = boundedString(result.qrcode, 4096); const content = boundedString(result.qrcode_img_content, 4096);
      const qrDataUrl = await QRCode.toDataURL(content, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
      this.controller.signal.throwIfAborted();
      const controller = new AbortController();
      const session: LoginSession = { userId, controller, code, base: WEIXIN_BASE, run: Promise.resolve(),
        view: { id: randomUUID(), state: 'wait', qrDataUrl, expiresAt: formatSystemTime(new Date(Date.now() + 300000)), message: '请用微信扫描二维码并确认连接' } };
      this.sessions.set(userId, session);
      session.run = this.poll(session).catch(() => { if (!controller.signal.aborted) { session.view.state = 'error'; session.view.message = '微信登录失败，请重新生成二维码'; } });
      return { ...session.view };
    } finally { this.starting.delete(userId); }
  }
  get(userId: string, id: string) {
    const session = this.sessions.get(userId);
    if (!session || session.view.id !== id) throw new ChannelError('扫码会话不存在或已失效', 404);
    return session;
  }
  view(userId: string, id: string) { return { ...this.get(userId, id).view }; }
  current(userId: string) { const session = this.sessions.get(userId); return session ? { ...session.view } : null; }
  verify(userId: string, id: string, code: string) {
    const session = this.get(userId, id);
    if (session.view.state !== 'need_verifycode' || parseSystemTime(session.view.expiresAt) <= Date.now() || !/^\d{1,12}$/.test(code)) throw new ChannelError('验证码或扫码状态无效', 409);
    if (session.verifyCode) throw new ChannelError('验证码正在验证，请稍候', 409);
    session.verifyCode = code; session.view.message = '正在验证，请稍候';
  }
  async cancel(userId: string, id: string) {
    const session = this.get(userId, id);
    session.controller.abort(); await session.run; this.sessions.delete(userId);
  }
  private async poll(session: LoginSession) {
    const signal = AbortSignal.any([session.controller.signal, this.controller.signal]);
    let redirects = 0; let errors = 0;
    while (!signal.aborted && parseSystemTime(session.view.expiresAt) > Date.now()) {
      if (session.view.state === 'need_verifycode' && !session.verifyCode) { await delay(300, undefined, { signal }); continue; }
      const verifyCode = session.verifyCode; session.verifyCode = undefined;
      try {
        const response = await this.api.status(session.base, session.code, AbortSignal.any([signal, AbortSignal.timeout(35000)]), verifyCode);
        signal.throwIfAborted(); errors = 0;
        if (parseSystemTime(session.view.expiresAt) <= Date.now()) break;
        switch (response.status) {
          case 'wait': session.view.state = 'wait'; session.view.message = '等待微信扫码'; break;
          case 'scaned': session.view.state = 'scaned'; session.view.message = '已扫码，请在微信确认'; break;
          case 'need_verifycode': session.view.state = 'need_verifycode'; session.view.message = verifyCode ? '验证码未通过，请重新输入手机显示的数字' : '请输入手机微信显示的数字'; break;
          case 'scaned_but_redirect':
            if (++redirects > 3) throw new ChannelError('微信登录跳转次数过多', 502);
            session.base = weixinBase(`https://${boundedString(response.redirect_host)}`); break;
          case 'confirmed': {
            const remoteId = boundedString(response.ilink_bot_id); const token = boundedString(response.bot_token, 4096);
            const baseUrl = weixinBase(boundedString(response.baseurl));
            const result = await this.channels.configure(session.userId, 'weixin', remoteId, token, baseUrl);
            if (signal.aborted) return;
            await this.channels.enable(result.id, session.userId, true);
            session.view.state = 'confirmed'; session.view.message = '微信已连接，请生成身份绑定码并发送给机器人'; session.view.qrDataUrl = ''; return;
          }
          case 'expired': session.view.state = 'expired'; session.view.message = '二维码已过期，请重新生成'; session.view.qrDataUrl = ''; return;
          case 'verify_code_blocked': session.view.state = 'error'; session.view.message = '验证码尝试过多，请稍后重新扫码'; session.view.qrDataUrl = ''; return;
          case 'binded_redirect': session.view.state = 'error'; session.view.message = '机器人已绑定其他连接，请在微信管理连接后重新扫码'; session.view.qrDataUrl = ''; return;
          default: throw new ChannelError('未知微信扫码状态', 502);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Error && error.name === 'TimeoutError') continue;
        if (error instanceof ChannelError || ++errors >= 5) throw error;
        session.view.message = '扫码状态查询失败，正在重试';
      }
      await delay(1000, undefined, { signal });
    }
    if (!signal.aborted) { session.view.state = 'expired'; session.view.message = '扫码已超时，请重新生成'; session.view.qrDataUrl = ''; }
  }
  async close() { this.controller.abort(); for (const session of this.sessions.values()) session.controller.abort(); await Promise.all([...this.sessions.values()].map(session => session.run)); }
}
