# MlClaw

运行在服务器上、通过浏览器访问的单用户个人 AI 助手。应用标识：`vip.mengluo.mlclaw`。

## 当前能力

已支持登录、多提供商与多模型配置、全局默认模型、流式对话、受限文件工具与覆盖授权、文件上传下载、显式长期记忆、助手身份与行为规则、模板、会话补充规则，以及任务取消和断线重连。

支持按服务器时区执行五段 Cron 定时计划：固定提醒、只读 AI 任务、启停、手动运行、取消、执行历史与提醒已读。可选择仅站内或投递到已绑定本人的 QQ／微信，展示独立发送状态；实际送达受平台权限及会话上下文影响。详见 [定时任务说明](docs/SCHEDULES.md)。

支持在网页“联网搜索”中配置 Tavily 密钥、搜索与正文读取，以及单独允许定时任务联网；保存即生效。工具提供来源链接并复用任务记录。当前完成模拟搜索服务验证，真实 Tavily 与模型联合效果待验收，见 [联网搜索说明](docs/WEB_SEARCH.md)。

支持会话手动摘要、默认关闭的会话自动摘要，以及相关记忆和历史工具结果检索。原始消息保留，摘要使用模型生成；当前完成模拟验证，真实摘要质量待验收。详见 [摘要与检索说明](docs/CONTEXT_MEMORY.md)。

支持“系统日志”查看服务、定时任务、消息渠道和敏感后台操作的实时活动与短期历史；默认保留 7 天，可配置 1–30 天，并有 20,000 条硬上限。页面记录采用脱敏结构化数据，详细技术诊断继续输出到服务标准输出。

支持网页维护技能和参考文档，助手根据任务自动选择、搜索并按需读取，任务显示实际加载版本。当前完成模拟流程验证，真实模型匹配效果待验收，见 [技能说明](docs/SKILLS.md)。

新增 QQ 官方机器人与微信机器人（iLink）私聊文本接入：网页配置、扫码、本人身份绑定和渠道会话已完成本地模拟验证；平台可用性受账号权限、额度及会话有效期影响，见 [渠道接入说明](docs/CHANNELS.md)。

前端采用 Element Plus 多页面布局，以对话为首页，设置与功能页面独立导航。提供 Docker 同源部署配置及 GHCR 自动发布流程，命令执行服务默认关闭且不包含在部署镜像中；项目规则、多助手等扩展仅完成设计。配置备份、导入导出和历史恢复已移除。

源码仓库：[mengluo04/MlClaw](https://github.com/mengluo04/MlClaw)。采用 [MIT 许可证](LICENSE)，第三方声明见 [THIRD_PARTY_NOTICES](docs/THIRD_PARTY_NOTICES.md)。

Docker 安装、HTTPS、持久化和升级步骤见 [部署说明](docs/DEPLOYMENT.md)。

## 快速启动

要求 Node.js 24 LTS、npm 11。在项目根目录执行：

```sh
npm ci
```

首次使用时，将 [.env.example](.env.example) 复制到 `apps/server/.env`，填写自己的 `ADMIN_PASSWORD`（12–256 字符），保留执行服务配置为空。已有环境文件不要覆盖。然后运行：

```sh
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`，登录后配置模型并创建对话。完整步骤、路径与常见问题见 [本机使用说明](docs/LOCAL_USAGE.md)。

## 文档导航

| 需要了解什么 | 文档 |
| --- | --- |
| 如何启动和使用 | [本机使用说明](docs/LOCAL_USAGE.md) |
| Docker 部署与镜像发布 | [部署说明](docs/DEPLOYMENT.md) |
| 如何连接 QQ 与微信机器人 | [渠道接入说明](docs/CHANNELS.md) |
| 如何设置 Cron 定时提醒与 AI 任务 | [定时任务说明](docs/SCHEDULES.md) |
| 如何配置 Tavily 联网搜索与网页读取 | [联网搜索说明](docs/WEB_SEARCH.md) |
| 如何使用摘要、记忆搜索与历史证据 | [摘要与检索说明](docs/CONTEXT_MEMORY.md) |
| 如何管理技能与自动匹配 | [技能说明](docs/SKILLS.md) |

## 常用开发命令

```sh
npm test
npm run typecheck
npm run build
npm run test:browser
```


`npm start` 默认只启动构建后的后端；设置 `SERVE_WEB=true` 和正确的 `APP_ORIGIN` 可同时托管前端。生产部署见部署说明。

日常开发使用 `master` 分支。提交前执行 `node scripts/check-public-files.mjs`、`npm test`、`npm run typecheck` 和 `npm run build`。测试中的模型及平台响应采用模拟服务，不能代替真实服务质量评估。浏览器完整测试默认使用 Windows Chrome，可通过 `BROWSER_PATH` 指定 Chromium；生产构建浏览器测试使用 `npm run test:production:browser`，需先构建。
