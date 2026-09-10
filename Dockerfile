# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/executor/package.json apps/executor/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY apps/server/src apps/server/src
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/web apps/web
COPY packages/shared packages/shared
COPY scripts/third-party-licenses.mjs scripts/third-party-licenses.mjs
RUN npm run build -w @mlclaw/server && npm run build -w @mlclaw/web
RUN node scripts/third-party-licenses.mjs

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/executor/package.json apps/executor/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --ignore-scripts -w @mlclaw/server -w @mlclaw/shared && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="MlClaw" \
      org.opencontainers.image.description="单用户个人 AI 助手" \
      org.opencontainers.image.source="https://github.com/mengluo04/MlClaw" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 SERVE_WEB=true \
    DATABASE_PATH=/app/data/mlclaw.sqlite WORKSPACE_PATH=/app/workspace TZ=Asia/Shanghai
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/server/package.json ./apps/server/package.json
COPY --from=dependencies /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY LICENSE ./LICENSE
COPY docs/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=build /app/dist/THIRD_PARTY_LICENSES.txt ./THIRD_PARTY_LICENSES.txt
RUN mkdir -p /app/data /app/workspace && chown node:node /app/data /app/workspace
USER node
WORKDIR /app/apps/server
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
