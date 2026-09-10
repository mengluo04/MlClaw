import { chromium, expect } from "@playwright/test";
import { createServer as createVite } from "vite";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../apps/server/src/app.js";
import { WeixinApi } from "../apps/server/src/channels/weixin.js";
import type {
  ChannelSink,
  OutboundMessage,
  TransportFactory,
} from "../apps/server/src/channels/types.js";

// 只连接本机可控模拟模型，不使用实际密钥。所有启动服务在 finally 关闭。
let requests = 0;
const contexts: string[] = [];
const modelCalls: { model: string; url: string; key: string }[] = [];
const mock = createServer(async (request, response) => {
  let text = "";
  for await (const part of request) text += part;
  const body = JSON.parse(text);
  requests++;
  contexts.push(JSON.stringify(body.messages));
  modelCalls.push({
    model: body.model,
    url: request.url!,
    key: request.headers.authorization ?? "",
  });
  if (!body.stream) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"choices":[{"message":{"content":"OK"}}]}');
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.flushHeaders();
  if (body.messages[0]?.content.includes("你是会话摘要器")) {
    if (body.tools?.length) throw new Error("摘要请求携带工具");
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "模拟摘要：保留浏览器早期目标，待办继续核实工具证据。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  if (
    body.messages
      .filter((message: { role: string }) => message.role === "user")
      .at(-1)?.content === "帮我汇总这周成果"
  ) {
    const count = body.messages.filter(
      (message: { role: string }) => message.role === "tool",
    ).length;
    const catalog = body.messages.find(
      (message: { role: string; content: string }) =>
        message.role === "system" && message.content.startsWith("可用技能目录"),
    );
    const skillId = JSON.parse(catalog.content.split("\n").at(-1)).skills[0].id;
    const names = ["search_skills", "read_skill", "read_skill_resource"];
    const args = [
      { query: "验收步骤" },
      { skillId },
      { skillId, name: "checklist.md" },
    ];
    const delta =
      count < 3
        ? {
            tool_calls: [
              {
                index: 0,
                id: `skill-${count}`,
                type: "function",
                function: {
                  name: names[count],
                  arguments: JSON.stringify(args[count]),
                },
              },
            ],
          }
        : { content: "模拟技能执行：已整理完成事项、风险及下周计划。" };
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: count < 3 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  if (
    body.messages
      .filter((message: { role: string }) => message.role === "user")
      .at(-1)?.content === "浏览器联网查询"
  ) {
    const count = body.messages.filter(
      (message: { role: string }) => message.role === "tool",
    ).length;
    const delta =
      count < 2
        ? {
            tool_calls: [
              {
                index: 0,
                id: `web-${count}`,
                type: "function",
                function: {
                  name: count === 0 ? "web_search" : "web_fetch",
                  arguments: JSON.stringify(
                    count === 0
                      ? { query: "模拟官方资料" }
                      : { url: "https://www.example.com/article" },
                  ),
                },
              },
            ],
          }
        : {
            content:
              "模拟联网结论，参见[官方资料](https://www.example.com/article)。",
          };
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: count < 2 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  if (body.messages.at(-1)?.content === "等待取消") return;
  if (body.messages.at(-1)?.content === "覆盖文件") {
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "browser-call", type: "function", function: { name: "write_text", arguments: JSON.stringify({ path: "approval.txt", content: "approved" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "模拟模型回复：你好\n<script>window.hacked=true</script>\n```js\nconst safe = true;\n```" }, finish_reason: null }] })}\n\n`,
  );
  response.end(
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );
});
await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
const address = mock.address();
if (!address || typeof address === "string")
  throw new Error("模拟服务地址无效");
mkdirSync(resolve("data"), { recursive: true });
const workspacePath = mkdtempSync(resolve("data/browser-"));
writeFileSync(resolve(workspacePath, "approval.txt"), "original");
const channelSinks = new Map<string, ChannelSink>();
const channelSent: OutboundMessage[] = [];
const channelFactory: TransportFactory = (account, sink) => {
  channelSinks.set(account.kind, sink);
  return {
    async run(signal) {
      if (signal.aborted) return;
      sink.state("connected");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    async send(message) {
      channelSent.push(message);
    },
  };
};
const weixinApi = new WeixinApi(
  async (url) =>
    new Response(
      JSON.stringify(
        String(url).includes("get_bot_qrcode")
          ? {
              qrcode: "mock-qr",
              qrcode_img_content: "https://example.test/mock-weixin-login",
            }
          : String(url).includes("verify_code=123456")
            ? {
                status: "confirmed",
                bot_token: "mock-weixin-secret",
                ilink_bot_id: "mock-weixin-bot",
                baseurl: "https://ilinkai.weixin.qq.com",
              }
            : { status: "need_verifycode" },
      ),
      { headers: { "Content-Type": "application/json" } },
    ),
);
let schedulerNow = new Date();
const webRequests: string[] = [];
const webRequest: typeof fetch = async (url) => {
  webRequests.push(String(url));
  return new Response(
    JSON.stringify({
      results: String(url).endsWith("/search")
        ? [
            {
              title: "模拟官方资料",
              url: "https://www.example.com/article",
              content: "模拟搜索摘要",
            },
          ]
        : [
            {
              url: "https://www.example.com/article",
              raw_content: "模拟网页正文证据",
            },
          ],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};
const { app, schedules, db, logs } = await createApp(
  {
    host: "127.0.0.1",
    port: 3100,
    databasePath: ":memory:",
    origin: "http://127.0.0.1:5174",
    secureCookie: false,
    adminUsername: "admin",
    adminPassword: "browser-test-only-123",
    sessionSeconds: 86400,
    workspacePath,
  },
  false,
  undefined,
  { factory: channelFactory, weixinApi },
  { clock: () => schedulerNow },
  webRequest,
);
const vite = await createVite({
  configFile: resolve("apps/web/vite.config.ts"),
  root: resolve("apps/web"),
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3100" },
  },
});
let captureFailure: (() => Promise<void>) | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await app.listen({ host: "127.0.0.1", port: 3100 });
  await vite.listen();
  browser = await chromium.launch({
    executablePath:
      process.env.BROWSER_PATH ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage({
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 1440, height: 1000 },
  });
  captureFailure = async () => {
    await page.screenshot({
      path: resolve("data/frontend-failure.png"),
      fullPage: true,
    });
    writeFileSync(resolve("data/frontend-failure.html"), await page.content());
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5174");
  await page.getByLabel("密码", { exact: true }).fill("browser-test-only-123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "模型服务", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "模型服务", exact: true }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "对话", exact: true }).click();
  const origin = { origin: "http://127.0.0.1:5174" };
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "新增提供商", exact: true }).click();
  await page.getByLabel("提供商名称", { exact: true }).fill("模拟服务");
  await page
    .getByLabel("服务地址", { exact: true })
    .fill(`http://127.0.0.1:${address.port}/v1`);
  await page.getByLabel("模型列表", { exact: true }).fill("mock-model");
  await page.getByLabel("API 密钥", { exact: true }).fill("test-only");
  await page.getByRole("button", { name: "保存提供商", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("提供商配置已保存");
  await page.getByRole("button", { name: "关闭此对话框", exact: true }).click();
  await page
    .locator(".el-select")
    .filter({ has: page.locator("#global-model") })
    .click();
  await page.getByRole("option", { name: "模拟服务 / mock-model" }).click();
  await page.getByRole("button", { name: "保存默认模型", exact: true }).click();
  await expect(
    page.getByText("全局默认模型已保存，后续所有新任务统一使用该模型"),
  ).toBeVisible();
  await page.getByRole("link", { name: "助手设置", exact: true }).click();
  await page.getByLabel("助手名称", { exact: true }).fill("新的助手");
  await page.getByRole("link", { name: "联网搜索", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("未保存");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("助手名称", { exact: true })).toHaveValue(
    "新的助手",
  );
  await page.getByRole("button", { name: "保存助手配置", exact: true }).click();
  await expect(
    page.getByText("助手配置已保存，从下一次提交消息生效"),
  ).toBeVisible();
  await page.getByRole("link", { name: "联网搜索", exact: true }).click();
  await page
    .getByLabel("搜索 API Key", { exact: true })
    .fill("mock-tavily-key");
  await page
    .locator(".el-checkbox")
    .filter({ hasText: "启用联网搜索" })
    .click();
  await expect(page.getByLabel("启用联网搜索", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "保存联网配置", exact: true }).click();
  await page.getByRole("button", { name: "测试联网连接", exact: true }).click();
  await expect.poll(() => webRequests.length).toBeGreaterThan(0);
  await page.getByRole("link", { name: "消息渠道", exact: true }).click();
  await page.getByLabel("QQ AppID", { exact: true }).fill("123456");
  await page.getByLabel("QQ AppSecret", { exact: true }).fill("test-qq-secret");
  await page.getByRole("button", { name: "保存 QQ 配置", exact: true }).click();
  await expect(
    page.getByText("QQ 配置已保存，请连接后生成身份绑定码"),
  ).toBeVisible();
  await page.getByRole("button", { name: "连接渠道", exact: true }).click();
  await page.getByRole("button", { name: "生成QQ绑定码", exact: true }).click();
  await expect(page.locator("pre").filter({ hasText: "/bind" })).toBeVisible();
  const bindText = (await page
    .locator("pre")
    .filter({ hasText: "/bind" })
    .textContent())!.trim();
  const beforeUnknown = requests;
  channelSinks.get("qq")!.receive({
    eventId: "stranger",
    senderId: "stranger",
    text: "读取文件",
    replyContext: "ctx",
  });
  channelSinks.get("qq")!.receive({
    eventId: "qq-bind",
    senderId: "qq-owner",
    text: bindText,
    replyContext: "bind-ctx",
  });
  await page.getByRole("button", { name: "刷新渠道状态", exact: true }).click();
  await expect(
    page.getByText("已绑定身份：qq-owner", { exact: true }),
  ).toBeVisible();
  const inbound = {
    eventId: "qq-hello",
    senderId: "qq-owner",
    text: "渠道你好",
    replyContext: "hello-ctx",
  };
  channelSinks.get("qq")!.receive(inbound);
  channelSinks.get("qq")!.receive(inbound);
  await expect
    .poll(
      () =>
        channelSent.filter((message) => message.eventId === "qq-hello").length,
    )
    .toBe(1);
  expect(requests).toBe(beforeUnknown + 1);
  await page.getByRole("button", { name: "微信扫码连接", exact: true }).click();
  await expect(page.getByAltText("微信机器人连接二维码")).toBeVisible();
  await expect(page.getByLabel("微信验证码", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByLabel("微信验证码", { exact: true }).fill("123456");
  await page
    .getByRole("button", { name: "提交微信验证码", exact: true })
    .click();
  const wxState = page.getByRole("article", {
    name: "微信渠道状态",
    exact: true,
  });
  await expect(wxState).toContainText("已连接", { timeout: 10000 });
  await wxState
    .getByRole("button", { name: "生成微信绑定码", exact: true })
    .click();
  channelSinks.get("weixin")!.receive({
    eventId: "wx-bind",
    senderId: "wx-owner",
    text: (await wxState.locator("pre").textContent())!.trim(),
    replyContext: "wx-ctx",
  });
  await page.getByRole("button", { name: "刷新渠道状态", exact: true }).click();
  await expect(wxState).toContainText("已绑定身份：wx-owner");
  const channelText = await (await page.request.get("/api/channels")).text();
  expect(channelText).not.toContain("test-qq-secret");
  expect(channelText).not.toContain("mock-weixin-secret");
  expect(channelText).not.toContain("hello-ctx");

  await page.getByRole("menuitem", { name: "对话", exact: true }).click();
  await expect(page).toHaveURL(/#\/chat$/);
  await page.reload();
  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(page).toHaveURL(/#\/chat\/[a-z0-9-]+$/);
  const firstChatUrl = page.url();
  await page.getByLabel("消息", { exact: true }).fill("浏览器你好");
  await page.getByLabel("消息", { exact: true }).press("Enter");
  await expect(
    page.locator(".chat-message").filter({ hasText: "模拟模型回复" }),
  ).toHaveCount(1);
  await expect(page.locator(".markdown script")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "复制代码" })).toBeVisible();
  await page.getByLabel("消息", { exact: true }).fill("未发送草稿");
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await page.goto(firstChatUrl);
  await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
    "未发送草稿",
  );
  await page.getByLabel("消息", { exact: true }).fill("等待取消");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  const requestCount = requests;
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await expect(page.getByRole("link", { name: /查看任务/ })).toBeVisible();
  await page.getByRole("link", { name: /查看任务/ }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  expect(requests).toBe(requestCount);
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await page.getByLabel("消息", { exact: true }).fill("覆盖文件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("article", { name: "待确认操作" })).toContainText(
    "approval.txt",
  );
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  expect(readFileSync(resolve(workspacePath, "approval.txt"), "utf8")).toBe(
    "original",
  );
  await page.getByLabel("消息", { exact: true }).fill("覆盖文件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "允许本次操作" }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  expect(readFileSync(resolve(workspacePath, "approval.txt"), "utf8")).toBe(
    "approved",
  );
  await page.getByRole("menuitem", { name: "文件", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "approval.txt", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "browser.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("上传内容"),
  });
  await page.getByRole("button", { name: "确认上传", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "browser.txt", exact: true }),
  ).toBeVisible();
  expect(readFileSync(resolve(workspacePath, "browser.txt"), "utf8")).toBe(
    "上传内容",
  );
  const download = await page.request.get(
    "/api/files/download?path=browser.txt",
  );
  expect(await download.text()).toBe("上传内容");
  await page.getByRole("menuitem", { name: "记忆与技能", exact: true }).click();
  await page.getByRole("button", { name: "添加记忆", exact: true }).click();
  await page.getByLabel("记忆内容", { exact: true }).fill("偏好中文简洁回答");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(page.locator(".memory-grid")).toContainText("偏好中文简洁回答");
  await page.getByLabel("记忆搜索关键词", { exact: true }).fill("中文简洁");
  await page.getByRole("button", { name: "搜索记忆", exact: true }).click();
  await expect(page.locator(".memory-grid")).toContainText("偏好中文简洁回答");
  await page.getByRole("link", { name: "技能管理", exact: true }).click();
  await page.getByRole("button", { name: "新增技能", exact: true }).click();
  await page.getByLabel("技能名称", { exact: true }).fill("weekly-report");
  await page.getByLabel("适用场景描述", { exact: true }).fill("用于周报整理");
  await page.getByLabel("匹配关键词", { exact: true }).fill("周报");
  await page
    .getByLabel("技能说明（Markdown）", { exact: true })
    .fill("先阅读 checklist.md，再整理周报。");
  await page.getByRole("button", { name: "添加参考文档", exact: true }).click();
  await page.getByLabel("文档 1 名称", { exact: true }).fill("checklist.md");
  await page
    .getByLabel("文档 1 正文", { exact: true })
    .fill("验收步骤：完成事项、风险、下周计划");
  await page.getByRole("button", { name: "保存技能", exact: true }).click();
  await expect(
    page.getByText("技能已保存；启用的技能可由助手自动选择，无需手动勾选。"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "← 返回技能列表", exact: true })
    .click();
  await page.getByLabel("技能试查关键词", { exact: true }).fill("验收步骤");
  await page.getByRole("button", { name: "搜索技能候选", exact: true }).click();
  await expect(page.getByRole("article", { name: "技能候选" })).toContainText(
    "weekly-report",
  );
  await page.getByRole("menuitem", { name: "定时任务", exact: true }).click();
  await page.getByRole("button", { name: "新增定时计划", exact: true }).click();
  await page.getByLabel("计划名称", { exact: true }).fill("浏览器提醒");
  await page.getByLabel("Cron 表达式", { exact: true }).fill("0 9 * * *");
  await page.getByRole("button", { name: "预览执行时间", exact: true }).click();
  await expect(page.getByText(/未来 5 次/)).toBeVisible();
  await page
    .locator(".el-select")
    .filter({ has: page.getByLabel("投递渠道", { exact: true }) })
    .click();
  await page
    .getByRole("option", { name: "QQ · 已绑定本人", exact: true })
    .click();
  await page.getByLabel("提醒内容", { exact: true }).fill("起来走一走");
  await page.getByRole("button", { name: "保存定时计划", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "浏览器提醒", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "立即运行", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "执行：浏览器提醒" }),
  ).toContainText("起来走一走");
  await expect(
    page.getByRole("article", { name: "执行：浏览器提醒" }),
  ).toContainText("平台已确认发送", { timeout: 10000 });
  await expect
    .poll(
      () =>
        channelSent.filter(
          (message) => message.proactive && message.text === "起来走一走",
        ).length,
    )
    .toBe(1);
  await page.getByRole("button", { name: "标为已读", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "执行：浏览器提醒" }),
  ).toContainText("已读");
  await page.getByRole("menuitem", { name: "运行记录", exact: true }).click();
  await page.getByRole("button", { name: "详情", exact: true }).first().click();
  await expect(
    page.getByRole("dialog", { name: "任务详情", exact: true }),
  ).toContainText("实际模型");
  await page.getByRole("button", { name: "关闭此对话框", exact: true }).click();
  await page.goto(firstChatUrl);
  // 中文组合输入、换行、失败保留草稿与相同幂等键恢复。
  await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
  await page.getByLabel("消息", { exact: true }).fill("中文输入中");
  const beforeComposition = requests;
  await page.getByLabel("消息", { exact: true }).dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
    "中文输入中",
  );
  expect(requests).toBe(beforeComposition);
  await page.getByLabel("消息", { exact: true }).press("Shift+Enter");
  await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
    "中文输入中\n",
  );
  await page.getByLabel("消息", { exact: true }).fill("幂等恢复消息");
  const keys: string[] = [];
  let lostResponse = false;
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().postDataJSON().idempotencyKey);
    if (!lostResponse) {
      lostResponse = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("消息", { exact: true })).toHaveValue(
    "幂等恢复消息",
  );
  await expect(page.getByRole("alert")).toContainText(/fetch|请求|Failed/i);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("消息", { exact: true })).toHaveValue("");
  expect(keys.length).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  await page.unroute("**/api/conversations/*/messages");
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await page.getByLabel("消息", { exact: true }).fill("帮我汇总这周成果");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("模拟技能执行：已整理完成事项、风险及下周计划。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("执行过程 · 3 项工具操作", { exact: true }).click();
  await expect(
    page.getByText(/已加载 weekly-report · 版本/).first(),
  ).toBeVisible();
  await page.getByLabel("消息", { exact: true }).fill("浏览器联网查询");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "官方资料", exact: true }),
  ).toHaveAttribute("href", "https://www.example.com/article");
  // 助手并发冲突保留草稿；模板预览后才应用。
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await page.getByRole("link", { name: "助手设置", exact: true }).click();
  const assistant = await (
    await page.request.get("/api/settings/assistant")
  ).json();
  await page.request.put("/api/settings/assistant", {
    headers: origin,
    data: {
      config: { ...assistant.config, name: "另一页面更新" },
      expectedVersion: assistant.version,
    },
  });
  await page.getByLabel("助手名称", { exact: true }).fill("未保存助手草稿");
  await page.getByRole("button", { name: "保存助手配置", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("其他页面更新");
  await expect(page.getByLabel("助手名称", { exact: true })).toHaveValue(
    "未保存助手草稿",
  );
  await page
    .getByRole("button", { name: "重新加载助手配置", exact: true })
    .click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByLabel("助手名称", { exact: true })).toHaveValue(
    "另一页面更新",
  );
  await page
    .locator("summary")
    .filter({ hasText: /^助手模板$/ })
    .click();
  await page.getByRole("button", { name: "加载助手模板", exact: true }).click();
  await page
    .locator(".el-select")
    .filter({ has: page.locator("#assistant-template") })
    .click();
  await page.getByRole("option", { name: /开发助手/ }).click();
  await page.getByRole("button", { name: "预览模板差异", exact: true }).click();
  await page.getByRole("button", { name: "应用到草稿", exact: true }).click();
  await expect(page.getByLabel("角色简介", { exact: true })).toHaveValue(
    "个人开发助手",
  );
  await page.getByRole("button", { name: "保存助手配置", exact: true }).click();
  await expect(
    page.getByText("助手配置已保存，从下一次提交消息生效"),
  ).toBeVisible();
  // 服务失败与重试；搜索密钥清除后不在响应中泄露。
  await page.getByRole("link", { name: "联网搜索", exact: true }).click();
  await page.route("**/api/settings/web", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"message":"模拟联网配置加载失败"}',
    }),
  );
  await page
    .getByRole("button", { name: "重新加载联网配置", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("模拟联网配置加载失败");
  await page.unroute("**/api/settings/web");
  await page
    .getByRole("button", { name: "重新加载联网配置", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .locator(".el-checkbox")
    .filter({ hasText: "清除搜索密钥并关闭联网" })
    .click();
  await page.getByRole("button", { name: "保存联网配置", exact: true }).click();
  await expect(
    page.getByText("密钥状态：未配置", { exact: true }),
  ).toBeVisible();
  // 长会话分页锚定、会话规则、手动及自动摘要。
  const longConversation = await (
    await page.request.post("/api/conversations", {
      headers: origin,
      data: { title: "长会话验收" },
    })
  ).json();
  for (let i = 0; i < 70; i++)
    db.prepare("INSERT INTO messages VALUES (?,?,?,?,?)").run(
      `long-${i}`,
      longConversation.id,
      i % 2 ? "assistant" : "user",
      `早期目标 ${i}：` + "需要保留的上下文。".repeat(30),
      "2026-09-09 12:00:00",
    );
  await page.goto(`http://127.0.0.1:5174/#/chat/${longConversation.id}`);
  await expect(page.locator(".chat-message")).toHaveCount(50);
  await page.locator(".message-viewport").evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  const anchor = page
    .locator(".chat-message")
    .filter({ hasText: "早期目标 20：" });
  const oldY = (await anchor.boundingBox())!.y;
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
  await expect(page.locator(".chat-message")).toHaveCount(70);
  expect(Math.abs((await anchor.boundingBox())!.y - oldY)).toBeLessThan(4);
  await page.getByRole("button", { name: "会话菜单", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "会话详情与规则", exact: true })
    .click();
  await page.getByText("会话补充规则", { exact: true }).click();
  await page
    .getByLabel("此对话的补充规则", { exact: true })
    .fill("只在本会话使用的规则");
  await page.getByRole("button", { name: "保存会话规则", exact: true }).click();
  await expect(
    page.getByText("会话规则已保存，仅影响此对话的新任务"),
  ).toBeVisible();
  const summaryPanel = page.locator('details[aria-label="会话摘要"]');
  await summaryPanel.locator("summary").click();
  await summaryPanel
    .getByRole("button", { name: "生成会话摘要", exact: true })
    .click();
  await expect(summaryPanel).toContainText("已覆盖 70 条", { timeout: 15000 });
  expect(
    db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?")
      .get(longConversation.id)!.n,
  ).toBe(70);
  await summaryPanel
    .locator(".el-checkbox")
    .filter({ hasText: "本会话自动摘要" })
    .click();
  await expect(summaryPanel.getByLabel("本会话自动摘要")).toBeChecked();
  await summaryPanel
    .getByRole("button", { name: "清除会话摘要", exact: true })
    .click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(summaryPanel).toContainText("尚未生成会话摘要");
  await expect(
    page.getByRole("dialog", { name: "确认操作", exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("dialog", { name: "会话详情与规则", exact: true })
    .getByRole("button", { name: "关闭此对话框", exact: true })
    .click();
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
  await expect(page.locator(".chat-message")).toHaveCount(70);
  await page.getByLabel("消息", { exact: true }).fill("继续早期目标");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect
    .poll(() => contexts.at(-1))
    .toContain("模拟摘要：保留浏览器早期目标");
  await expect(page.locator(".chat-message")).toHaveCount(72);
  await page.goto(firstChatUrl);
  await expect(page.locator(".conversation-heading")).toContainText("新对话");
  await expect(page.locator(".app-sidebar .el-menu-item.is-active")).toHaveText(
    "对话",
  );
  await page.getByRole("menuitem", { name: "系统日志", exact: true }).click();
  await expect(page.getByRole("heading", { name: "系统日志", exact: true })).toBeVisible();
  await expect(page.getByText("实时更新中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "暂停页面更新", exact: true }).click();
  const logUserId = String(db.prepare("SELECT id FROM users LIMIT 1").get()!.id);
  logs.record(logUserId, { level: "warning", source: "system", event: "system.browser_test", message: "浏览器实时日志验证" });
  await expect(page.getByText(/暂停期间有 1 条新日志/)).toBeVisible();
  await page.getByRole("button", { name: "继续实时更新", exact: true }).click();
  await expect(page.locator("tbody").getByText("浏览器实时日志验证", { exact: true })).toBeVisible();
  await page.getByLabel("保留天数", { exact: true }).fill("5");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => Number(db.prepare("SELECT retention_days FROM system_log_settings WHERE user_id=?").get(logUserId)!.retention_days)).toBe(5);
  await page.goto(firstChatUrl);
  await page.screenshot({
    path: resolve("data/frontend-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page
    .getByRole("menuitem", { name: "定时任务", exact: true })
    .last()
    .click();
  await expect(page.getByRole("button", { name: "打开导航" })).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "MlClaw", exact: true }),
  ).not.toBeVisible();
  await page.screenshot({
    path: resolve("data/frontend-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("手机页面横向溢出");
  await expect(
    page
      .locator(".mobile-data")
      .getByRole("button", { name: "编辑", exact: true })
      .first(),
  ).toBeVisible();
  for (const destination of [
    "history",
    "logs",
    "files",
    "knowledge/memories",
    "settings/models",
    "settings/channels",
  ]) {
    await page.goto(`http://127.0.0.1:5174/#/${destination}`);
    await expect(page.locator(".feature-panel")).toBeVisible();
    if (destination === "settings/models") {
      const edit = page
        .locator(".mobile-data")
        .getByRole("button", { name: "编辑", exact: true });
      await expect(edit).toBeVisible();
      await edit.click();
      const drawer = page.getByRole("dialog", {
        name: "编辑提供商",
        exact: true,
      });
      await expect(
        drawer.getByLabel("提供商名称", { exact: true }),
      ).toHaveValue("模拟服务");
      await drawer
        .getByRole("button", { name: "关闭此对话框", exact: true })
        .click();
      await expect(drawer).not.toBeVisible();
    }
    await page.screenshot({
      path: resolve(
        `data/frontend-${destination.replace("/", "-")}-mobile.png`,
      ),
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto(firstChatUrl);
  await page.setViewportSize({ width: 390, height: 500 });
  const composer = page.getByLabel("消息", { exact: true });
  await expect(composer).toBeVisible();
  const bounds = await composer.boundingBox();
  expect(
    bounds && bounds.y >= 0 && bounds.y + bounds.height <= 500,
  ).toBeTruthy();
  await page.screenshot({
    path: resolve("data/frontend-chat-mobile.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "收起导航", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "展开导航", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "前端完整浏览器验证通过：登录导航、配置和冲突、聊天幂等/取消/授权/跨页、文件、记忆、技能加载、联网来源、Cron投递与提醒、QQ微信模拟绑定、运行历史、系统日志实时/保留设置和手机布局；外部服务全部模拟",
  );
} catch (cause) {
  try {
    await captureFailure?.();
  } catch {
    /* 页面崩溃时仍报告原始测试错误。 */
  }
  throw cause;
} finally {
  await browser?.close();
  await vite.close();
  await app.close();
  mock.closeAllConnections();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  if (!workspacePath.startsWith(resolve("data")))
    throw new Error("测试清理路径越界");
  rmSync(workspacePath, { recursive: true });
}
