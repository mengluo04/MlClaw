# Docker 部署与 GHCR 发布

首版镜像为 `ghcr.io/mengluo04/mlclaw:0.1.0`，目标架构 `linux/amd64`。容器提供同源前端与 API，命令执行服务不包含在镜像及 Compose 中；暂不提供 ARM64 镜像，真实模型及公网证书需要在实际部署环境中确认。

## 安装前提

运行镜像不需要安装 Node.js、npm 或克隆源码。准备可用的 Linux Docker 引擎；Windows 使用 Docker Desktop 的 Linux 容器模式。下面的独立 Compose 示例要求 Docker Compose 2.30 或更新版本。

选择一种方式启动同一个实例即可，不要同时运行两份服务访问同一数据库。

## 方式一：docker run

在自己的部署目录新建 `.env.docker`，保存为 UTF-8，填写以下内容：

```dotenv
NODE_ENV=development
APP_ORIGIN=http://127.0.0.1:3000
ADMIN_USERNAME=admin
# 首次启动前填写自己生成的 12–256 字符密码。
ADMIN_PASSWORD=
TZ=Asia/Shanghai
LOG_LEVEL=info
```

每行一个 `名称=值`，值不用加引号。管理员密码不能为空；建议使用密码管理器生成随机密码。不要把该文件提交到 Git。模型密钥在登录后的网页中配置。

在该目录执行以下命令。`docker run` 写为单行，可直接用于 Windows PowerShell 或 Linux Shell：

```sh
docker pull ghcr.io/mengluo04/mlclaw:0.1.0
docker run -d --name mlclaw --restart unless-stopped --init --env-file ./.env.docker -p 127.0.0.1:3000:3000 -v mlclaw_data:/app/data -v mlclaw_workspace:/app/workspace --read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL --security-opt no-new-privileges=true --pids-limit 256 --memory 1g --cpus 2 --stop-timeout 30 --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 ghcr.io/mengluo04/mlclaw:0.1.0
```

浏览器打开 `http://127.0.0.1:3000`，使用 `admin` 和刚填写的密码登录。命名卷由 Docker 创建，数据分别保存在 `mlclaw_data` 和 `mlclaw_workspace`，不会因为删除容器而自动删除。

查看状态、日志及停止服务：

```sh
docker ps --filter name=mlclaw
docker logs --tail 100 mlclaw
docker stop mlclaw
docker start mlclaw
```

如果提示容器名称已存在，先用 `docker ps -a --filter name=mlclaw` 确认现有实例。修改环境文件或镜像版本后需要重建容器，单纯 `docker restart` 不会应用新的环境变量。

更新前备份数据，然后执行：

```sh
docker stop mlclaw
docker rm mlclaw
```

将前面的 `docker pull` 和 `docker run` 中镜像标签改为目标版本，重新执行；保留相同的两个卷名。不要删除命名卷。初始化后可以清空 `.env.docker` 的 `ADMIN_PASSWORD` 并重建，已有管理员继续有效。

## 方式二：独立 compose.yml

无需克隆项目。在自己的部署目录保存上面的 `.env.docker`，再新建 `compose.yml`：

```yaml
name: mlclaw
services:
  mlclaw:
    image: ghcr.io/mengluo04/mlclaw:0.1.0
    restart: unless-stopped
    init: true
    env_file:
      - path: ./.env.docker
        format: raw
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - mlclaw_data:/app/data
      - mlclaw_workspace:/app/workspace
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    pids_limit: 256
    mem_limit: 1g
    cpus: 2
    stop_grace_period: 30s
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
volumes:
  mlclaw_data:
    name: mlclaw_data
  mlclaw_workspace:
    name: mlclaw_workspace
```

`format: raw` 保留密码中的 `$` 等字符，与 `docker run --env-file` 使用同一份文件；需要 Compose 2.30 或更新版本。配置语义见 [Docker 环境文件说明](https://docs.docker.com/reference/compose-file/services/#env_file)。

在该目录执行：

```sh
docker compose -f compose.yml config --quiet
docker compose -f compose.yml pull
docker compose -f compose.yml up -d
docker compose -f compose.yml ps
docker compose -f compose.yml logs --tail=100 mlclaw
```

访问地址和登录方式同上。停止服务使用 `docker compose -f compose.yml down`；再次启动使用 `up -d`。更新时先备份，将 `image` 改成目标版本，再执行 `pull` 和 `up -d`。不要附加 `down -v`，它会删除数据卷。

这两份独立示例使用相同的显式卷名。从 `docker run` 切换到独立 Compose 时，先停止并删除旧容器，再启动 Compose，数据继续保留。已有仓库 Compose 部署的卷名默认带项目名前缀；不要直接套用独立示例，以免连接到新空卷，应先核对 `docker volume ls` 和现有挂载。

## 端口、访问地址与 HTTPS

以上示例默认只允许部署机器本机访问。更换本机端口，例如 8080，需将端口映射改成 `127.0.0.1:8080:3000`，同时设置 `APP_ORIGIN=http://127.0.0.1:8080`，再重建容器。容器内部端口仍是 3000。

公网使用 `NODE_ENV=production` 和 `APP_ORIGIN=https://你的域名`，由反向代理提供 HTTPS；不能只将容器端口开放到公网就当作 HTTPS 部署。`APP_ORIGIN` 必须与浏览器地址完全一致，不能带末尾斜杠或路径。下面提供仓库内置的 Caddy 组合配置；已有代理也可以转发到主机 `127.0.0.1:3000`。

## 方式三：使用仓库内置 Compose

部署机需要 Docker Engine 与 Compose v2；Windows 使用 Docker Desktop 的 Linux 容器模式。本机只负责编辑和推送代码时不需要 Docker，GitHub Actions 可以构建镜像。

```sh
git clone https://github.com/mengluo04/MlClaw.git
cd MlClaw
```

将 `deploy/.env.example` 复制为根目录 `.env`，填写自己的 `ADMIN_PASSWORD`（12–256 字符）。它只用于首次数据库初始化，之后修改该变量不会修改已有管理员密码。配置中的模型、QQ、微信和 Tavily 密钥在登录后的网页填写，不作为镜像构建参数。

### 仓库配置的本机运行

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
