# Qoder Sites A 方案 · 上线结果（2026-11-27 傍晚）

> 公网：<https://code-cultivation-game-x4r5qii0vbg.qoder.zone/>
> 目标：把静态站点升级为 Qoder Function backend + 数据库，社交/社区真正可用。

## 一、做了什么

- 在 Qoder Sites 站点「代码修仙」启用 **database + functions + storage**，`databaseAccessModel=function_backend`。
- 数据库迁移 `qoder/schema.sql`：`app.players / runs / posts / post_likes / comments / reports` 6 表 + 索引。
- Function：`functions/index.ts` + `functions/routes.mjs`，与 Node 版 `server/index.mjs` 同语义：
  - 注册/`/api/me`（应用 token，不依赖 Qoder 登录）
  - 境界榜、提交成绩
  - 帖子/点赞/评论/举报/删除
  - 6 条官方种子帖
- 前端 `communityApi.ts` 自动判断 Qoder 域名，走 `/functions/v1/app/api/...`；Node 版仍 `/api`。
- 发布：Qoder `prepare_site`（`webDirectory=apps/web/dist`、`functionDirectory=functions`、`databaseAccess=read_write`）+ `publish_site`。

## 二、线上验证

| 项 | 结果 |
|---|---|
| `/functions/v1/app/api/health` | 200 `{ok:true}` |
| 注册（中文昵称） | 201 |
| `/api/me` + `x-gongfa-token` | 200，昵称正确 |
| 发帖 | 201 |
| 点赞 | 200，likes 1 |
| 评论 | 201，回读持久化 |
| 提交成绩/榜单 | 201 / 200，榜单出现 |
| 真实浏览器 | 社区按钮出现；Qoder 内置浏览器同源请求全部通过 |

## 三、踩坑与修复

1. **迁移类型限制**：Qoder 迁移只支持 boolean/integer/bigint/text/uuid/timestamptz/jsonb；`double precision` 被拒。`rate` 改 `jsonb`，读取 `Number(run.rate)`。
2. **索引 DESC**：不支持 `created_at DESC` 索引，改普通索引。
3. **异步错误边界**：`Deno.serve` 里 `return handle(context)` 不 await，业务异常没进 `errorResponse`，`/api/me` 500；改成 `async` + `return await handle(context)`。
4. **Gateway 剥离 Authorization**：应用 token 改自定义头 `x-gongfa-token`，前端/Function/Node 三处同步。
5. **Qoder 页面 BOT 检测**：CDP/headless 会收到 403 `BOT_DETECTED`；真实浏览器正常。验收必须用真实浏览器或 Qoder 内置浏览器。

## 四、边界

- Qoder Sites 页面提示「网站仅供临时访问，如需长期使用，请自行迁移至其他托管平台」；比赛期间可用，长期需迁到自有服务器（`server/` 已备）。
- 成绩仍是客户端提交，服务端只字段校验；榜单写明「仅作社区参考」。
- 没有实时聊天/PvP/公会；社区是异步帖子 + 榜单。
- Qoder Sites 的数据库/Function 由平台托管；备份/迁移需平台能力。
