import { formatSystemTime, parseSystemTime } from '../time.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { WeixinLoginView } from '@mlclaw/shared';
import { boundedString, ChannelError } from './types.js';
import { WeixinApi, weixinBase, WEIXIN_BASE } from './weixin.js';
import type { ChannelManager } from './manager.js';

interface LoginSession {
  userId: string;
  view: WeixinLoginView;
  controller: AbortController;
  run: Promise<void>;
  code: string;
  base: string;
  verifyCode?: string;
}
export class WeixinLogin {
  /** 按用户保存的扫码登录会话。 */
  private sessions = new Map<string, LoginSession>();
  /** 正在生成二维码的用户集合。 */
  private starting = new Set<string>();
  /** 用于主动取消当前操作的控制器。 */
  private controller = new AbortController();
  constructor(
    private channels: ChannelManager,
    private api = new WeixinApi(),
  ) {}
  /** 创建微信扫码会话并在后台轮询登录状态。 */
  async start(userId: string) {
    if (this.controller.signal.aborted) throw new ChannelError('服务正在关闭', 503);
    if (this.starting.has(userId)) throw new ChannelError('二维码正在生成，请稍后重试', 409);
    /** 该用户之前的扫码登录会话。 */
    const previous = this.sessions.get(userId);
    if (
      previous &&
      !['confirmed', 'expired', 'error'].includes(previous.view.state) &&
      parseSystemTime(previous.view.expiresAt) > Date.now()
    )
      throw new ChannelError('已有待扫码登录，请先取消或等待过期', 409);
    this.starting.add(userId);
    try {
      previous?.controller.abort();
      await previous?.run;
      /** 本次处理结果。 */
      const result = await this.api.qr(
        AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
      );
      /** 当前消息中的协议代码或验证码。 */
      const code = boundedString(result.qrcode, 4096);
      /** 当前记录的正文内容。 */
      const content = boundedString(result.qrcode_img_content, 4096);
      /** 二维码图像的数据地址。 */
      const qrDataUrl = await QRCode.toDataURL(content, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      this.controller.signal.throwIfAborted();
      /** 用于主动取消当前操作的控制器。 */
      const controller = new AbortController();
      /** 当前用户的微信扫码登录会话。 */
      const session: LoginSession = {
        userId,
        controller,
        code,
        base: WEIXIN_BASE,
        run: Promise.resolve(),
        view: {
          id: randomUUID(),
          state: 'wait',
          qrDataUrl,
          expiresAt: formatSystemTime(new Date(Date.now() + 300000)),
          message: '请用微信扫描二维码并确认连接',
        },
      };
      this.sessions.set(userId, session);
      session.run = this.poll(session).catch(() => {
        if (!controller.signal.aborted) {
          session.view.state = 'error';
          session.view.message = '微信登录失败，请重新生成二维码';
        }
      });
      return { ...session.view };
    } finally {
      this.starting.delete(userId);
    }
  }
  /** 校验用户与扫码会话标识后返回内部会话。 */
  get(userId: string, id: string) {
    /** 当前用户的微信扫码登录会话。 */
    const session = this.sessions.get(userId);
    if (!session || session.view.id !== id) throw new ChannelError('扫码会话不存在或已失效', 404);
    return session;
  }
  /** 将内部记录映射为对外展示结构。 */
  view(userId: string, id: string) {
    return { ...this.get(userId, id).view };
  }
  /** 读取当前有效记录。 */
  current(userId: string) {
    /** 当前用户的微信扫码登录会话。 */
    const session = this.sessions.get(userId);
    return session ? { ...session.view } : null;
  }
  /** 校验验证码格式并提交给当前等待验证的扫码会话。 */
  verify(userId: string, id: string, code: string) {
    /** 当前用户的微信扫码登录会话。 */
    const session = this.get(userId, id);
    if (
      session.view.state !== 'need_verifycode' ||
      parseSystemTime(session.view.expiresAt) <= Date.now() ||
      !/^\d{1,12}$/.test(code)
    )
      throw new ChannelError('验证码或扫码状态无效', 409);
    if (session.verifyCode) throw new ChannelError('验证码正在验证，请稍候', 409);
    session.verifyCode = code;
    session.view.message = '正在验证，请稍候';
  }
  /** 取消当前执行并更新相关状态。 */
  async cancel(userId: string, id: string) {
    /** 当前用户的微信扫码登录会话。 */
    const session = this.get(userId, id);
    session.controller.abort();
    await session.run;
    this.sessions.delete(userId);
  }
  /** 轮询上游状态并处理取消。 */
  private async poll(session: LoginSession) {
    /** 当前操作的取消信号。 */
    const signal = AbortSignal.any([session.controller.signal, this.controller.signal]);
    /** 已跟随的登录端点重定向次数。 */
    let redirects = 0;
    /** 连续登录状态查询失败次数。 */
    let errors = 0;
    while (!signal.aborted && parseSystemTime(session.view.expiresAt) > Date.now()) {
      if (session.view.state === 'need_verifycode' && !session.verifyCode) {
        await delay(300, undefined, { signal });
        continue;
      }
      /** 微信扫码登录要求补充的验证码。 */
      const verifyCode = session.verifyCode;
      session.verifyCode = undefined;
      try {
        /** 请求返回的响应。 */
        const response = await this.api.status(
          session.base,
          session.code,
          AbortSignal.any([signal, AbortSignal.timeout(35000)]),
          verifyCode,
        );
        signal.throwIfAborted();
        errors = 0;
        if (parseSystemTime(session.view.expiresAt) <= Date.now()) break;
        switch (response.status) {
          case 'wait':
            session.view.state = 'wait';
            session.view.message = '等待微信扫码';
            break;
          case 'scaned':
            session.view.state = 'scaned';
            session.view.message = '已扫码，请在微信确认';
            break;
          case 'need_verifycode':
            session.view.state = 'need_verifycode';
            session.view.message = verifyCode
              ? '验证码未通过，请重新输入手机显示的数字'
              : '请输入手机微信显示的数字';
            break;
          case 'scaned_but_redirect':
            if (++redirects > 3) throw new ChannelError('微信登录跳转次数过多', 502);
            session.base = weixinBase(`https://${boundedString(response.redirect_host)}`);
            break;
          case 'confirmed': {
            /** 上游平台记录标识。 */
            const remoteId = boundedString(response.ilink_bot_id);
            /** 当前认证或平台访问令牌。 */
            const token = boundedString(response.bot_token, 4096);
            /** 服务基础地址。 */
            const baseUrl = weixinBase(boundedString(response.baseurl));
            /** 本次处理结果。 */
            const result = await this.channels.configure(
              session.userId,
              'weixin',
              remoteId,
              token,
              baseUrl,
            );
            if (signal.aborted) return;
            await this.channels.enable(result.id, session.userId, true);
            session.view.state = 'confirmed';
            session.view.message = '微信已连接，请生成身份绑定码并发送给机器人';
            session.view.qrDataUrl = '';
            return;
          }
          case 'expired':
            session.view.state = 'expired';
            session.view.message = '二维码已过期，请重新生成';
            session.view.qrDataUrl = '';
            return;
          case 'verify_code_blocked':
            session.view.state = 'error';
            session.view.message = '验证码尝试过多，请稍后重新扫码';
            session.view.qrDataUrl = '';
            return;
          case 'binded_redirect':
            session.view.state = 'error';
            session.view.message = '机器人已绑定其他连接，请在微信管理连接后重新扫码';
            session.view.qrDataUrl = '';
            return;
          default:
            throw new ChannelError('未知微信扫码状态', 502);
        }
      } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
        if (signal.aborted) return;
        if (error instanceof Error && error.name === 'TimeoutError') continue;
        if (error instanceof ChannelError || ++errors >= 5) throw error;
        session.view.message = '扫码状态查询失败，正在重试';
      }
      await delay(1000, undefined, { signal });
    }
    if (!signal.aborted) {
      session.view.state = 'expired';
      session.view.message = '扫码已超时，请重新生成';
      session.view.qrDataUrl = '';
    }
  }
  /** 关闭当前资源或编辑界面。 */
  async close() {
    this.controller.abort();
    for (/* 逐项处理当前用户的登录与助手状态。 */ const session of this.sessions.values())
      session.controller.abort();
    await Promise.all([...this.sessions.values()].map((session) => session.run));
  }
}
