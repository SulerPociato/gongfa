# 社区版 · 部署与社交（2026-11-27）

> 目标：白天把项目部署到服务器；加社交属性、社区内容；所有道具继续走已实装的机制。

## 一、产品视角

### 做什么

- **账号**：昵称 + 本机 token，不要密码；换设备重新登记。
- **境界榜**：按本境用时排序；客户端提交，服务端只字段校验。
- **社区**：帖子、点赞、评论、举报；种子 10 条官方攻略/公告。
- **分享**：晒本局成绩（境界/用时/速率/种子）；发帖附带当前功法；别人一键「抄作业」。
- **部署**：同一个 Node 进程托管静态站 + `/api`；零第三方依赖，Node 18+ 可跑。

### 不做什么（明确边界）

- 不做实时聊天、好友、公会、PvP、合作渡劫：要 WebSocket、账号体系、审核与反作弊，两天做不完整。
- 不做服务端存档：存档仍在 localStorage；社区只存公开帖子和成绩。
- 不做防作弊榜：客户端可改包；界面写「客户端提交，仅作社区参考」。

## 二、开发视角

- `server/index.mjs`：Node 内置 `http/fs/crypto`；`DATA_DIR/db.json` 原子写；API + 静态站。
- 账号：随机 token，只存 SHA-256；`POST /api/register` 只返回一次 token。
- 榜单：`POST /api/runs` 按玩家+境界保留最快；`GET /api/leaderboard?realm=`。
- 社区：`GET/POST /api/posts`、like、comments、report、delete。
- 前端：`communityApi.ts` + `CommunityPanel.tsx`；顶栏「社区」按钮先探活 `/api/health`，纯静态 Pages 自动隐藏。
- 部署：`server/README.md`、`Dockerfile`、`deploy/nginx` 说明；`pnpm build` + `node server/index.mjs`。
- 数据：`data/` 不入库；备份 `db.json`。

## 三、用户视角（验收）

1. 打开服务器地址，顶栏有「社区」；纯 GitHub Pages 没有。
2. 登记昵称 → 境界榜提交本局 → 榜单出现自己的用时。
3. 社区看到 10 条官方帖；能发帖、点赞、评论、举报。
4. 帖子带功法码 → 点「抄作业」→ 确认覆盖 → 画布变成对方功法。
5. 手机上面板全屏、可滚动，无横向溢出。

## 四、三遍对抗性评审

### 第一遍：安全/滥用

| 质疑 | 结论 |
|---|---|
| 没密码，token 泄露怎么办 | token 只存本机；泄露等于丢号；不做找回，文档写明 |
| 昵称冒充/脏话 | 2–16 字、唯一；举报入库；管理员 `ADMIN_TOKEN` 删帖；不做自动审核 |
| XSS | 前端全部 React 文本节点，不用 `dangerouslySetInnerHTML` |
| 刷帖/刷榜 | 每 IP 120 请求/分；帖子 2000 字、build 12k；榜单每玩家每境保留最快；仍可多开，社区参考 |
| 改包刷成绩 | 服务端不重放，无法防；界面明说 |

### 第二遍：部署/运维

| 质疑 | 结论 |
|---|---|
| 服务器没有 pnpm/构建环境 | Dockerfile 多阶段构建；或本地 `pnpm build` 后只拷 `server` + `dist` |
| 没有数据库 | JSON + 原子写；小社区够用；上量换 Postgres 只改 store |
| 静态和 API 不同源 | 同源 Node 托管；Nginx 也可只反代 `/api` |
| 端口/数据目录 | `PORT` / `DATA_DIR` / `WEB_DIST` 环境变量 |
| 数据丢失 | `db.json` 备份；`data/` 已 gitignore |
| HTTPS | 由 Nginx/Caddy 终止；服务端只 HTTP |

### 第三遍：体验/回归

| 质疑 | 结论 |
|---|---|
| 纯静态 Pages 出现坏社区按钮 | 先探活 `/api/health` 且校验 `{ok:true}`，探不到隐藏 |
| 手机顶栏挤爆 | 390px 实测：按钮 90px，无横向溢出 |
| 社区面板挡住确认框 | modal z-index 400 > 社区 300 |
| 提交成绩用总时长还是本境时长 | 本境：进入当前境界时记起点；刷新后从当前时刻重算 |
| 旧 E2E 选择器 | `.topbar-community` 新增；原有选择器不变 |

## 五、结果（2026-11-27）

- 服务端接口：注册/榜单/帖子/点赞/评论/举报/删除/健康检查，Node 直连验证通过。
- 前端：社区面板（榜单/社区/我的），注册、发帖、点赞、评论、提交成绩、抄作业导入全部 E2E 通过。
- 社区种子：10 条官方内容（新手、阵法、九境、宗门、丹药、公告、天阶、灵根、手机、规则）。
- 静态 Pages：社区按钮自动隐藏（无 `/api`）。
- typecheck 0；**672 测试 / 55 文件**；fuzz 0；a11y 0 失败。
- 服务端未跑 Docker（本机 Docker daemon 未启动）；Dockerfile/README 已给，需在服务器上验证。
- Pages：`index-fSE0mwsZ.js`，社区按钮正确隐藏；服务器版 bundle 由同一份 dist 提供。
- 仍未做：实时聊天/PvP/公会、服务端存档、防作弊回放、自动审核。
