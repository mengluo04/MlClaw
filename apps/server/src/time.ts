/** 业务时间使用服务器进程的系统时区，精确到秒。 */
export function serverTimezone() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }

export function formatSystemTime(date = new Date(), timezone = serverTimezone()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

/** 显式使用本地日期时间语法，不依赖对空格格式的宽松解析。 */
export function parseSystemTime(value: string): number {
  return Date.parse(value.replace(' ', 'T'));
}
