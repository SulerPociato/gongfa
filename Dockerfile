# 社区版镜像：构建前端 → 只带 dist + server 运行（服务端零依赖）
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY content ./content
COPY tools ./tools
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @gongfa/web build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY server ./server
COPY package.json ./
ENV PORT=8787
ENV DATA_DIR=/data
ENV WEB_DIST=/app/apps/web/dist
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "server/index.mjs"]
