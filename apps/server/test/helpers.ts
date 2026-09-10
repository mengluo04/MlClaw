import { createApp } from '../src/app.js';
import type { Provider } from '../src/providers/types.js';
export async function fixture(provider?: Provider, workspacePath?: string, channelOptions?: Parameters<typeof createApp>[3], schedulerOptions?: Parameters<typeof createApp>[4], webRequest?: typeof fetch) {
  const origin = 'http://127.0.0.1:5173';
  const instance = await createApp({ host: '127.0.0.1', port: 3000, databasePath: ':memory:', origin, secureCookie: false, adminUsername: 'admin', adminPassword: 'test-password-only-123', sessionSeconds: 86400, workspacePath }, false, provider ? () => provider : undefined, channelOptions, schedulerOptions, webRequest);
  const login = await instance.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password: 'test-password-only-123' } });
  const headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]! };
  const conversation = (await instance.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: { title: '测试对话' } })).json();
  return { ...instance, headers, conversationId: String(conversation.id) };
}
export async function waitFor(check: () => boolean, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('等待条件超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
