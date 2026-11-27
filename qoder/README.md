# Qoder Sites 社区后端（A 方案）

2026-11-27 已在 Qoder Sites 站点「代码修仙」启用 **Function backend（database + functions + storage）**，社区 API 由 `functions/` 提供，数据在 Qoder 数据库。

- 公网：<https://code-cultivation-game-x4r5qii0vbg.qoder.zone/>
- 站点/项目：`01a21c6e-bae4-711d-9034-78c4e2c43895` / `01a21c6e-bae0-766b-8d9e-0042d18c6c5f`
- 数据库 schema：`qoder/schema.sql`（`app.players/runs/posts/post_likes/comments/reports`）
- Function 入口：`functions/index.ts`；业务路由：`functions/routes.mjs`
- 前端请求前缀：Qoder 域名下 `/functions/v1/app`，Node 版仍是 `/api`（`communityApi.ts` 自动判断）
- 应用 token 头：`x-gongfa-token`（Qoder Gateway 会剥离 `Authorization`）

## 重新部署

在 Qoder Desktop 的 Sites 面板或 Qoder agent 会话里：

1. 确认站点已启用 backend（本次已启用）。
2. 若改 schema：用 `qoder/schema.sql` 生成并应用迁移。
3. `pnpm --filter @gongfa/web build`
4. `prepare_site`：`projectRoot=D:\gongfa`、`webDirectory=apps/web/dist`、`functionDirectory=functions`、`databaseAccess=read_write`、`schemaRef` 取当前值、`spa=true`。
5. `publish_site`，然后验证 `/functions/v1/app/api/health`、`/api/posts`、注册/发帖。

## 注意

- Qoder Sites 的 Function 路由由平台重写；`routes.mjs` 同时兼容 `/functions/v1/app/...` 与物理 function 前缀。
- `_qoder/backend.mjs` 由平台注入，**不要**创建 `functions/_qoder`。
- Qoder Sites 页面带 BOT 检测：CDP/headless 可能收到 403 `BOT_DETECTED`；真实浏览器不受影响。
- 数据库/函数/Schema 的 readiness 与发布是不同生命周期；发布后仍要单独验证真实请求。
