import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../apps/server/dist/app.js';

await mkdir(resolve('data'), { recursive: true });
const root = await mkdtemp(resolve('data/production-browser-'));
const password = randomBytes(24).toString('hex');
const config = { host: '127.0.0.1', port: 0, origin: 'http://127.0.0.1', databasePath: join(root, 'database.sqlite'), workspacePath: join(root, 'workspace'), secureCookie: false, adminUsername: 'admin', adminPassword: password, sessionSeconds: 3600, serveWeb: true };
const { app } = await createApp(config);
let browser;
try {
  config.origin = await app.listen({ host: config.host, port: config.port });
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(config.origin);
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill('admin');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.app-shell').waitFor();
  await page.goto(`${config.origin}/#/settings/models`);
  await page.getByRole('heading', { name: '模型设置', exact: true }).waitFor();
  await page.reload();
  await page.locator('.app-shell').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve('data/production-browser-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('生产构建浏览器验证通过：同源资源、登录、懒加载页面、刷新会话、手机宽度；没有调用真实模型。');
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
