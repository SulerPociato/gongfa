# 社区版服务端部署

这是《代码修仙》从「纯静态单机」升级到「服务器 + 社区」的部署说明。服务端**零第三方依赖**，只用 Node 内置模块，Node 18+ 可跑。

## 一、最快路径（裸 Node）

```bash
# 1. 构建前端
pnpm install --frozen-lockfile
pnpm build

# 2. 启动（静态站 + /api 同一个端口）
PORT=8787 DATA_DIR=/var/lib/gongfa node server/index.mjs
```

打开 `http://服务器IP:8787/` 即可。前端会自动探活 `/api/health`，探到才显示「社区」按钮；纯静态 Pages 上按钮会自动隐藏，不会出现一堆 404。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录（`db.json`） |
| `WEB_DIST` | `./apps/web/dist` | 前端构建产物 |
| `ADMIN_TOKEN` | 空 | 设置后可用 `x-admin-token` 删除任意帖子 |

### systemd 示例

```ini
[Unit]
Description=gongfa community
After=network.target

[Service]
WorkingDirectory=/opt/gongfa
Environment=PORT=8787
Environment=DATA_DIR=/var/lib/gongfa
ExecStart=/usr/bin/node server/index.mjs
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

## 二、Docker

```bash
docker build -t gongfa-community .
docker run -d --name gongfa -p 8787:8787 -v gongfa-data:/data gongfa-community
```

## 三、Nginx 反代（可选）

如果已经有 Nginx，可以让它托管静态文件、只把 `/api/` 转给 Node：

```nginx
server {
  listen 80;
  server_name game.example.com;
  root /opt/gongfa/apps/web/dist;
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 128k;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

## 四、数据与备份

- 所有社区数据在 `DATA_DIR/db.json`：玩家、榜单、帖子、评论、举报。
- 写入是「tmp + rename」原子写；备份直接复制 `db.json`。
- 这是小社区 MVP；要上量再换 Postgres（只需替换 `server/index.mjs` 里的 `loadDb/persist`）。
- 不要提交 `data/` 到 git（已在 `.gitignore`）。

## 五、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 探活 |
| POST | `/api/register` | `{name}` → `{player,token}`，token 只返回一次 |
| GET | `/api/me` | Bearer token |
| GET | `/api/leaderboard?realm=0..8` | 本境最快用时 |
| POST | `/api/runs` | `{realm,elapsedMs,rate,seed,build?}` |
| GET | `/api/posts?sort=hot|new` | 帖子 |
| POST | `/api/posts` | `{title,body,build?,seed?}` |
| POST | `/api/posts/:id/like` | 点赞/取消 |
| GET/POST | `/api/posts/:id/comments` | 评论 |
| POST | `/api/posts/:id/report` | 举报 |
| DELETE | `/api/posts/:id` | 作者或管理员 |

## 六、已知边界

- 成绩由客户端提交，服务端只做字段校验，**不能防改包**；正式榜单需要服务端重放/校验。
- 账号是「昵称 + 本机 token」，没有密码找回；换设备要重新登记。
- 没有实时聊天/PvP/公会；社区是异步帖子 + 榜单。
- 举报只入库，没有自动审核；管理员用 `ADMIN_TOKEN` 删帖。
- 服务端不存游戏存档；存档仍在浏览器 localStorage。
