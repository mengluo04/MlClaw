import type { ScheduleInput } from '@mlclaw/shared';
import type { ChannelManager } from '../channels/manager.js';
import type { ScheduleManager } from '../schedules/manager.js';
import { scheduleProperties, scheduleVersion } from '../schedules/schema.js';
import { TaskError } from '../tasks/manager.js';
import { ToolError } from './files.js';
import type { ToolRegistry } from './registry.js';

/** 为当前用户注册应用内置计划工具，复用网页的校验、存储与调度服务。 */
export const registerScheduleTools = (
  registry: ToolRegistry,
  manager: ScheduleManager,
  channels: ChannelManager,
  userId: string,
) => {
  /** 所有查询和变更均绑定服务端当前用户，不接收模型提供的身份。 */
  const store = manager.store;
  const id = { type: 'string', minLength: 1, maxLength: 100 };
  /** 将可公开的业务错误反馈给模型纠错，不暴露底层数据库异常。 */
  const execute = (operation: () => unknown) => {
    try {
      return operation();
    } catch (error) {
      if (error instanceof TaskError) throw new ToolError(error.message);
      throw error;
    }
  };
  /** 统一使用注册表的参数校验、取消检查及任务工具记录。 */
  const add = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    operation: (args: Record<string, unknown>) => unknown,
  ) =>
    registry.add(
      name,
      description,
      properties,
      required,
      () => ({ snapshot: '' }),
      (args) => execute(() => operation(args)),
    );

  add(
    'list_delivery_channels',
    '查询当前用户实际配置的 QQ、微信（weixin）、Webhook、邮箱（email）定时投递渠道及启用/绑定/连接状态。不返回凭据。创建推送计划前先查询，使用返回的 id；available 表示可选择，不保证实际送达。空列表表示尚未配置，不能据此声称系统没有微信功能。',
    {},
    [],
    () => ({
      supportedKinds: [
        'qq',
        'weixin',
        'webhook',
        'email',
        'telegram',
        'slack',
        'discord',
        'dingtalk',
        'feishu',
        'wecom',
      ],
      channels: channels.view(userId).accounts.map((account) => ({
        id: account.id,
        kind: account.kind,
        displayName: account.displayName,
        enabled: account.enabled,
        state: account.state,
        scheduleDelivery: account.scheduleDelivery,
      })),
      note: '在网页“消息渠道”配置和绑定本人；微信发送需要本人最近的入站消息上下文，QQ 受主动消息权限限制。平台确认发送不等于已读。',
    }),
  );
  add(
    'list_schedules',
    '查询 MlClaw 内置定时计划、服务器时区与调度错误；不依赖系统 crontab。每页最多 10 条摘要，详情使用 read_schedule，按 nextOffset 继续读取。',
    { offset: { type: 'integer', minimum: 0, maximum: 100 } },
    [],
    (args) => {
      const schedules = store.list(userId);
      const offset = Number(args.offset ?? 0);
      return {
        timezone: store.timezone,
        schedulerError: manager.commands?.error ?? manager.error,
        total: schedules.length,
        schedules: schedules.slice(offset, offset + 10).map(({ content, ...schedule }) => ({
          ...schedule,
          contentPreview: content.slice(0, 200),
        })),
        nextOffset: offset + 10 < schedules.length ? offset + 10 : null,
      };
    },
  );
  add(
    'read_schedule',
    '读取当前用户指定计划的完整配置和版本，修改前先读取。',
    { scheduleId: id },
    ['scheduleId'],
    (args) => store.get(String(args.scheduleId), userId),
  );
  add(
    'preview_schedule',
    '按服务器时区预览五段数字 Cron（分 时 日 月 周）的未来 5 次时间。仅支持重复计划，不支持一次性或秒级定时；创建前核实时间，不能将一次性请求当作重复计划。',
    { cron: scheduleProperties.cron },
    ['cron'],
    (args) => store.preview(String(args.cron)),
  );
  add(
    'create_schedule',
    '按用户要求创建应用内置重复计划。agent 内容是只读 AI 提示词；command 内容是已存在工作区脚本命令，commandOptions.timeoutMs 必填。enabled=true 即允许重复执行最新脚本。推送使用 list_delivery_channels 返回的可用 id；null 为仅站内。保存成功后报告 id、启用状态、下次时间，不能声称已执行或已送达。',
    scheduleProperties,
    ['name', 'kind', 'content', 'cron', 'enabled'],
    (args) => store.save(userId, args as unknown as ScheduleInput),
  );
  add(
    'update_schedule',
    '按用户要求修改指定计划；先 read_schedule 获取完整配置与 version 作为 expectedVersion，保留无需修改的字段。省略 deliveryChannelId 保留原渠道，null 清除。版本冲突先重新读取，不覆盖其他修改。暂停不取消正在运行的实例。',
    { ...scheduleProperties, scheduleId: id, expectedVersion: scheduleVersion },
    ['scheduleId', 'expectedVersion', 'name', 'kind', 'content', 'cron', 'enabled'],
    (args) =>
      store.save(
        userId,
        args as unknown as ScheduleInput,
        String(args.scheduleId),
        Number(args.expectedVersion),
      ),
  );
  add(
    'delete_schedule',
    '仅当用户要求删除计划时调用；先 read_schedule 获取 version 作为 expectedVersion。保留执行历史，取消未启动实例，正在运行的实例需在定时任务页面单独取消。',
    { scheduleId: id, expectedVersion: scheduleVersion },
    ['scheduleId', 'expectedVersion'],
    (args) => {
      store.remove(String(args.scheduleId), userId, Number(args.expectedVersion));
      return { deleted: true, scheduleId: String(args.scheduleId) };
    },
  );
};
