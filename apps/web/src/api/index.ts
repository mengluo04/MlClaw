export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    signal: AbortSignal.timeout(20000),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401)
    window.dispatchEvent(new Event("mlclaw:expired"));
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      typeof value.message === "string" ? value.message : "请求失败",
      response.status,
    );
  return value as T;
}
