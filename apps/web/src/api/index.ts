export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export class ApiTimeoutError extends Error {
  constructor() {
    super('网页请求超时，不代表后台任务已停止；请稍后重新加载会话查看状态');
  }
}
/** 发送 API 请求并统一解析响应与错误。 */
export const api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  const signal = AbortSignal.timeout(20000);
  try {
    /** 请求返回的响应。 */
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) window.dispatchEvent(new Event('mlclaw:expired'));
    /** 响应正文解析得到的数据。 */
    const value = await response.json();
    if (!response.ok)
      throw new ApiError(
        typeof value.message === 'string' ? value.message : '请求失败',
        response.status,
      );
    return value as T;
  } catch (cause) {
    if (signal.aborted) throw new ApiTimeoutError();
    throw cause;
  }
};
