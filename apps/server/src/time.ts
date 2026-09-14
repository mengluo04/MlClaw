/** 业务时间使用服务器进程的系统时区，精确到秒。 */
export const serverTimezone = () => {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
};

/** 将时间格式化为服务器时区的年月日时分秒。 */
export const formatSystemTime = (date = new Date(), timezone = serverTimezone()): string => {
  /** 按服务器时区格式化后的日期时间字段集合。 */
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  /** 读取对应字段的值。 */
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
};

/** 显式使用本地日期时间语法，不依赖对空格格式的宽松解析。 */
export const parseSystemTime = (value: string): number => {
  return Date.parse(value.replace(' ', 'T'));
};
