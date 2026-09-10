# Docker 部署与 GHCR 发布

首版镜像为 `ghcr.io/mengluo04/mlclaw:0.1.0`，目标架构 `linux/amd64`。容器提供同源前端与 API，命令执行服务不包含在镜像及 Compose 中；暂不提供 ARM64 镜像，真实模型及公网证书需要在实际部署环境中确认。

## 获取配置

部署机需要 Docker Engine 与 Compose v2；Windows 使用 Docker Desktop 的 Linux 容器模式。本机只负责编辑和推送代码时不需要 Docker，GitHub Actions 可以构建镜像。

```sh
git clone https://github.com/mengluo04/MlClaw.git
cd MlClaw
```

将 `deploy/.env.example` 复制为根目录 `.env`，填写自己的 `ADMIN_PASSWORD`（12–256 字符）。它只用于首次数据库初始化，之后修改该变量不会修改已有管理员密码。配置中的模型、QQ、微信和 Tavily 密钥在登录后的网页填写，不作为镜像构建参数。

## 本机体验

根目录 `.env` 使用以下配置，仍须自行填写管理员密码：

```dotenv
MLCLAW_VERSION=0.1.0
NODE_ENV=development
APP_ORIGIN=http://127.0.0.1:3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
TZ=Asia/Shanghai
HTTP_PORT=3000
```

```sh
docker compose pull
docker compose up -d
docker compose ps
```

访问 `http://127.0.0.1:3000`。端口默认只绑定本机回环地址；此配置用于本机 HTTP 体验，公网部署使用下节生产配置。官方 `0.1.0` 和 `latest` 已验证可匿名拉取；自行发布为私有镜像时需先登录 `ghcr.io`。

## 公网 HTTPS

准备一个解析到服务器的域名，并确保服务器的 80/443 端口能从公网访问。根目录 `.env` 设置 `NODE_ENV=production`、`APP_ORIGIN=https://你的域名` 和 `MLCLAW_DOMAIN=你的域名`，来源不能带路径或末尾斜杠。

```sh
docker compose -f compose.yaml -f compose.https.yaml pull
docker compose -f compose.yaml -f compose.https.yaml up -d
```

Caddy 自动申请证书并代理到 `mlclaw:3000`。已配置即时刷新 SSE，未设置限制长流的响应正文超时。生产登录 Cookie 使用 Secure、HttpOnly、SameSite=Strict。应用不信任转发 IP，代理后的登录频率限制会按代理地址合并，符合当前单用户部署方式。

已有反向代理时只运行基础 Compose，将代理指向主机 `127.0.0.1:3000`，设置相同的 HTTPS 来源，关闭 SSE 缓冲并允许长连接。应用本身不终止 TLS。证书签发是否成功取决于实际域名、DNS 与网络，配置文件不代表公网验收通过。

## 数据、更新与恢复

- `mlclaw_data` 命名卷：SQLite、会话、模型与渠道凭据等服务数据。
- `mlclaw_workspace` 命名卷：用户授权给助手操作的文件；与数据库分离。
- 根目录 `.env`：部署配置；Caddy 的证书在独立卷持久化。
- 服务以 UID/GID 1000 的非 root 用户运行；根文件系统只读，临时目录为有界 tmpfs。
- 每实例最多 1 GiB 内存、2 CPU、256 进程；技术日志最多 3 个 10 MiB 文件。应用活动日志按网页配置保留，默认 7 天。命名卷磁盘使用仍需部署者监控。
- 健康检查访问 `/api/health`，仅表示服务存活，不代表模型或渠道平台可用。单份数据库只允许一个服务实例，不能横向扩容共享该卷。

更新前停止应用并备份数据卷、工作卷及部署配置，再将 `.env` 的 `MLCLAW_VERSION` 改成目标版本，执行 `docker compose pull` 与 `docker compose up -d`。使用 HTTPS 组合配置的部署，所有命令都带相同的两项 `-f` 参数。

数据库迁移在启动时运行。回退镜像可能不兼容较新的数据库结构；恢复时同时使用对应旧版本和升级前的数据备份。项目不提供应用内备份、导入导出或历史恢复界面。需要保留数据时不要执行 `docker compose down -v`，该命令会删除命名卷。普通 `down` 与容器重建会保留卷。

初始化后可清空 `.env` 中的 `ADMIN_PASSWORD` 并重建容器，已有管理员继续有效。容器启动失败先查看 `docker compose logs --tail=100 mlclaw`，检查密码、HTTPS 来源及卷权限。

## 源码构建与自动发布

本机也可运行 `docker build -t mlclaw:local .`。构建使用白名单上下文，不包含 `.git`、`.env`、数据库、工作目录、测试输出和命令执行服务。运行依赖与构建依赖分层，最终镜像保留第三方许可。

GitHub 的 `master` 提交和 Pull Request 自动执行类型检查、自动化测试、前后端构建、生产构建浏览器验证、Compose 语法检查和真实容器测试。测试使用独立临时数据，不调用真实模型或消息平台。

发布步骤：

1. 更新根包和内部包版本以及锁文件、Compose 默认版本、示例与文档，确保测试通过。
2. 将代码推送到 GitHub `master`。
3. 在 Releases 创建 `v版本号`（如 `v0.1.0`）并发布，标签必须与根 `package.json` 的正式版本一致。
4. 发布工作流重新验收，再使用内置 `GITHUB_TOKEN` 上传版本镜像；正式 Release 同时更新 `latest`。部署建议固定版本。
5. 检查镜像可见性；如果是 Private，到个人资料 Packages → mlclaw → Package settings 改为 Public，再验证匿名拉取。不要只依据源码仓库可见性推断镜像权限。

工作流不保存个人访问令牌，不对外部 Pull Request 授予写镜像权限。发布镜像不会自动更新任何用户服务器。
