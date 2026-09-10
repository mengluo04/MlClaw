import { formatSystemTime, serverTimezone } from '../time.js';
import { CronExpressionParser } from 'cron-parser';
import { TaskError } from '../tasks/manager.js';

export { serverTimezone } from '../time.js';

export function cronPreview(expression: string, now = new Date(), timezone = serverTimezone(), count = 5) {
  const cron = expression.trim().replace(/\s+/g, ' ');
  // 仅提供可确定的标准五段数字表达式，不开放秒、别名或随机 H 扩展。
  if (cron.length > 100 || cron.split(' ').length !== 5 || !/^[\d*,/\- ]+$/.test(cron)) {
    throw new TaskError('请输入五段 Cron：分 时 日 月 周，仅支持数字、*、逗号、范围和步长');
  }
  try {
    const parsed = CronExpressionParser.parse(cron, { currentDate: now, tz: timezone });
    const nextRuns = parsed.take(count).map(date => formatSystemTime(date.toDate(), timezone));
    return { cron, timezone, nextRuns };
  } catch { throw new TaskError('Cron 表达式无效或没有可执行时间，请检查字段范围与日期'); }
}
