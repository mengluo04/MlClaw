import { formatSystemTime, serverTimezone } from '../time.js';
import { CronExpressionParser } from 'cron-parser';
import { TaskError } from '../tasks/manager.js';

export { serverTimezone } from '../time.js';

/** 按服务器时区计算 Cron 后续触发时间。 */
export const cronPreview = (
  expression: string,
  now = new Date(),
  timezone = serverTimezone(),
  count = 5,
) => {
  /** 合并多余空白后的五段 Cron 表达式。 */
  const cron = expression.trim().replace(/\s+/g, ' ');
  // 仅提供可确定的标准五段数字表达式，不开放秒、别名或随机 H 扩展。
  if (cron.length > 100 || cron.split(' ').length !== 5 || !/^[\d*,/\- ]+$/.test(cron)) {
    throw new TaskError('请输入五段 Cron：分 时 日 月 周，仅支持数字、*、逗号、范围和步长');
  }
  try {
    /** 按当前时间与服务器时区解析的 Cron 迭代器。 */
    const parsed = CronExpressionParser.parse(cron, { currentDate: now, tz: timezone });
    /** 按 Cron 计算的后续触发时间列表。 */
    const nextRuns = parsed.take(count).map((date) => formatSystemTime(date.toDate(), timezone));
    return { cron, timezone, nextRuns };
  } catch {
    throw new TaskError('Cron 表达式无效或没有可执行时间，请检查字段范围与日期');
  }
};
