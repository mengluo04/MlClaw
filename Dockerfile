# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --no-audit --no-fund
COPY apps/server/ apps/server/
COPY apps/web/ apps/web/
COPY packages/shared/ packages/shared/
RUN npm run typecheck -w @mlclaw/server \
    && npm run build -w @mlclaw/server \
    && npm run build -w @mlclaw/web
# 构建完成后重新安装服务端生产依赖，运行镜像不包含前端构建工具。
RUN npm ci --omit=dev --workspace=@mlclaw/server --include-workspace-root=false --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOME=/home/node
# 安装脚本通过 SHELL 识别配置文件；服务子进程直接继承 PATH，不读取 .bashrc。
ENV SHELL=/bin/bash
ENV PATH="/home/node/.local/bin:${PATH}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
# Git 在 umask 077 下检出的文件可能为 600；COPY 会保留权限。
# 仅规范镜像内的应用代码和依赖，不修改宿主源码、凭据或运行时挂载。
RUN chmod -R a+rX /app \
    && mkdir -p /app/data /app/workspace /home/node/.local/bin \
    && chown node:node /app/data /app/workspace /home/node/.local /home/node/.local/bin
USER node
# 在构建时以实际运行用户检查入口、包配置和生产依赖可读。
RUN node --check apps/server/dist/index.js \
    && node --input-type=module -e "import { readFileSync } from 'node:fs'; for (const path of ['apps/server/package.json', 'packages/shared/package.json']) JSON.parse(readFileSync(path, 'utf8')); await import('fastify');"
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "apps/server/dist/index.js"]
