# 渠道协议参考与第三方许可

MlClaw 独立调用平台接口，不加载 OpenClaw 运行时。以下发布包用于核查协议：

| 来源 | 版本 | 用途 |
| --- | --- | --- |
| [腾讯 openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) | 2.4.8 | iLink 扫码、状态、轮询和文本回复，MIT |
| [腾讯 qqbot-nodejs](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs) | 1.0.4 | QQ Bot 令牌、网关握手、心跳和私聊字段，发布包声明 MIT |

微信实现参考 `src/auth/login-qr.ts`、`src/api/api.ts`、`src/api/types.ts` 和 `src/messaging/send.ts`，保留上游许可如下。插件不作为运行依赖安装，不读写 `~/.openclaw`。

## openclaw-weixin 许可

```text
Tencent is pleased to support the open source community by making openclaw-weixin available.

Copyright (C) 2026 Tencent. All rights reserved.

openclaw-weixin is licensed under the MIT.

Terms of the MIT:
--------------------------------------------------------------------
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

新增运行依赖 `ws`（WebSocket）和 `qrcode`（本地二维码生成）均为 MIT，精确版本由根 `package-lock.json` 固定。类型声明包只用于开发。平台账号资格和 API 使用权限仍由对应平台决定。

Docker 同源静态托管使用 `@fastify/static`（MIT）。镜像构建执行 `node scripts/third-party-licenses.mjs`，从实际安装包收集许可、NOTICE 和作者声明，保存在镜像 `/app/THIRD_PARTY_LICENSES.txt`，覆盖打包后不再单独分发 node_modules 的前端依赖。本说明另保存在 `/app/THIRD_PARTY_NOTICES.md`；项目自身使用根目录 MIT 许可证。Caddy 与 Node 基础镜像保留各自上游声明。
