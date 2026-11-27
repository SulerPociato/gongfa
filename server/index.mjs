#!/usr/bin/env node
/**
 * 《代码修仙》社区服务端（2026-11-27）
 *
 * 目标：把纯静态单机版升级成「可部署到一台服务器」的社区版。
 * - 零第三方依赖：只用 Node 内置 http/fs/crypto/path/url；Node 18+ 可跑。
 * - 静态站 + /api 同源：前端构建产物由本服务直接托管，不需要 nginx 也能跑。
 * - 存储：DATA_DIR/db.json，原子写（tmp + rename）。小社区够用；换 Postgres 时只换 store。
 * - 账号：昵称 + 随机 token；token 只存 SHA-256，客户端只拿一次。
 *
 * 启动：
 *   PORT=8787 DATA_DIR=./data node server/index.mjs
 * 环境变量：
 *   PORT            监听端口（默认 8787）
 *   DATA_DIR        数据目录（默认 ./data）
 *   WEB_DIST        前端 dist 目录（默认 ./apps/web/dist）
 *   ADMIN_TOKEN     管理员删除帖子的 token（可选）
 */
import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(HERE, '..', 'data'));
const WEB_DIST = resolve(process.env.WEB_DIST ?? join(HERE, '..', 'apps', 'web', 'dist'));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const DB_PATH = join(DATA_DIR, 'db.json');
const BODY_LIMIT = 64 * 1024;

const now = () => Date.now();
const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
const id = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`;
const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

const SEED_POSTS = [
  {
    title: '新人第一课：循环比多叠吐纳更划算',
    body: '先把「吐纳」拖进「每 tick」，再用「循环 3 次」包住它：同样的动作数，步数更少。筑基后给循环配玉简，重复动作会打折但省步。别一上来就堆十块吐纳，预算会先撞墙。',
  },
  {
    title: '阵法的正确用法：只追加，不替换',
    body: '金丹后去「阵法阁」点「拓印到现有功法」：它只接在「每 tick」链尾，不会动你已有的引灵。想自己搭，就把「引灵」拖进功法，再把「阵图 N 眼」拖进它的阵位。2 眼 +26%，但每次多走 3 步。',
  },
  {
    title: '九境路线：化神之后怎么走',
    body: '炼气→筑基→金丹→元婴→化神→炼虚→合体→大乘→渡劫。前四境约 11 分钟；化神起每境更慢，蓄势 8/12/18/25/30 分钟。元婴之后宗门/界域和丹药会明显影响节奏。',
  },
  {
    title: '宗门/界域怎么选：看你要产出还是稳',
    body: '仙剑门、天机阁偏产出；万佛宗、菩提学院压心魔；魔道宗门产出高但心魔也高。界域同理：鬼域/魔域是高风险高产出，海域/云之法界更稳。选错了可以改，不用重开档。',
  },
  {
    title: '丹药别囤：什么时候吃',
    body: '首次试炼每个境界掉一枚丹。筑基丹/元阳丹补存量，洗髓丹/清蕴丹压心魔，结续丹解走火罚站，碧髓丸直接完成蓄势。它们不占丹炉 45 秒冷却，该吃就吃。',
  },
  {
    title: '版本公告：社区版上线',
    body: '社区版支持昵称、境界榜、发帖/评论/点赞、晒本局成绩、复制别人的功法码。服务端只存你提交的公开内容；存档仍在本地。遇到坏帖点举报，管理员会处理。',
  },
  {
    title: '天阶功法怎么解锁：先搭出来，再免费学',
    body: '藏经阁的天阶 10 套是 0 悟道的，但按钮会写「需先领悟：某某图案」。先去画布把对应结构搭出来（比如归并吐纳要先有「沙漏/分批」），图鉴点亮后再回来点「参悟」。不用攒悟道。',
  },
  {
    title: '灵根与开局：同一套功法为什么别人快',
    body: '灵根由种子决定，天灵根心魔 ×0.75，下品 ×1.1；它不改产出，只改心魔增速。所以低品灵根要更早放调息，或者选万佛宗/玉净瓶这类压心魔的配置。',
  },
  {
    title: '手机操作：积木太小/拖不动怎么办',
    body: '窄屏会自动缩到 0.72；积木库在左侧，点一下会直接接到「每 tick」链尾。画布可以双指缩放；如果「每 tick」跑出屏幕，刷新后会自动居中。',
  },
  {
    title: '社区规则（暂行）',
    body: '只聊游戏与算法；不发自认侵权/广告/人身攻击内容；剧透标一下。举报会进管理员队列，重复违规的昵称会被删除帖子。榜单成绩由客户端提交，只作社区参考。',
  },
];

let db = null;
let writing = Promise.resolve();

function emptyDb() {
  return { version: 1, players: [], runs: [], posts: [], comments: [], reports: [] };
}

async function loadDb() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DB_PATH)) {
    db = emptyDb();
    seedDb();
    await persist();
    return;
  }
  try {
    db = JSON.parse(await readFile(DB_PATH, 'utf8'));
    if (typeof db !== 'object' || db === null) throw new Error('bad db');
    for (const key of ['players', 'runs', 'posts', 'comments', 'reports']) {
      if (!Array.isArray(db[key])) db[key] = [];
    }
    if (!db.posts.some((post) => post.id === 'system_welcome')) {
      seedDb();
      await persist();
    } else {
      const before = db.posts.length;
      seedDb();
      if (db.posts.length !== before) await persist();
    }
  } catch (error) {
    console.error('[db] 读取失败，使用空库：', error.message);
    db = emptyDb();
    seedDb();
    await persist();
  }
}

function seedDb() {
  const created = now();
  for (const [index, post] of SEED_POSTS.entries()) {
    if (db.posts.some((entry) => entry.title === post.title)) continue;
    db.posts.push({
      id: index === 0 ? 'system_welcome' : id('post'),
      authorId: 'system',
      authorName: '天机阁',
      title: post.title,
      body: post.body,
      build: '',
      seed: null,
      createdAt: created + index,
      likes: [],
      flags: [],
    });
  }
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writing = writing.then(async () => {
    const tmp = `${DB_PATH}.tmp`;
    await writeFile(tmp, snapshot, 'utf8');
    await rename(tmp, DB_PATH);
  }).catch((error) => console.error('[db] 写入失败：', error.message));
  return writing;
}

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not object');
        resolvePromise(value);
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function playerFrom(req) {
  const direct = req.headers['x-gongfa-token'];
  const header = req.headers.authorization ?? '';
  const token = typeof direct === 'string' && direct.length >= 20
    ? direct
    : (header.startsWith('Bearer ') ? header.slice(7) : '');
  if (token === '') return null;
  const tokenHash = hash(token);
  return db.players.find((player) => player.tokenHash === tokenHash) ?? null;
}

function publicPlayer(player) {
  return player === null ? null : { id: player.id, name: player.name, createdAt: player.createdAt };
}

function publicPost(post) {
  const comments = db.comments.filter((comment) => comment.postId === post.id);
  return {
    id: post.id,
    authorName: post.authorName,
    title: post.title,
    body: post.body,
    build: post.build ?? '',
    seed: post.seed ?? null,
    createdAt: post.createdAt,
    likes: post.likes.length,
    liked: false,
    comments: comments.length,
    pinned: post.id === 'system_welcome',
  };
}

function sanitizeText(value, max) {
  return typeof value === 'string' ? value.replace(/\s+$/u, '').trim().slice(0, max) : '';
}

function isName(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}_-]{2,16}$/u.test(value.trim());
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = normalize(join(WEB_DIST, relative));
  if (!file.startsWith(WEB_DIST)) return send(res, 403, 'forbidden');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=60' });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(WEB_DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      send(res, 404, 'not found');
    }
  }
}

const rateBuckets = new Map();
function rateLimited(ip) {
  const bucket = rateBuckets.get(ip) ?? { count: 0, at: now() };
  if (now() - bucket.at > 60_000) {
    bucket.count = 0;
    bucket.at = now();
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count > 120;
}

async function api(req, res, url) {
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (rateLimited(ip)) return send(res, 429, { error: '请求太频繁，歇一会' });
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/health') {
    return send(res, 200, { ok: true, players: db.players.length, posts: db.posts.length, at: now() });
  }

  if (method === 'POST' && path === '/api/register') {
    const body = await readJson(req);
    const name = sanitizeText(body.name, 16);
    if (!isName(name)) return send(res, 400, { error: '昵称 2–16 位，中文/字母/数字/下划线' });
    if (db.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) {
      return send(res, 409, { error: '这个昵称已经有人用了' });
    }
    const token = randomBytes(24).toString('base64url');
    const player = { id: id('p'), name, tokenHash: hash(token), createdAt: now() };
    db.players.push(player);
    await persist();
    return send(res, 201, { player: publicPlayer(player), token });
  }

  if (method === 'GET' && path === '/api/me') {
    const player = playerFrom(req);
    if (player === null) return send(res, 401, { error: '未登录' });
    return send(res, 200, { player: publicPlayer(player) });
  }

  if (method === 'GET' && path === '/api/leaderboard') {
    const realm = clampInt(url.searchParams.get('realm'), 0, 8, -1);
    const rows = [];
    for (const player of db.players) {
      const best = db.runs
        .filter((run) => run.playerId === player.id && (realm < 0 || run.realm === realm))
        .sort((a, b) => a.elapsedMs - b.elapsedMs || a.createdAt - b.createdAt)[0];
      if (best !== undefined) rows.push({ ...best, playerName: player.name });
    }
    rows.sort((a, b) => a.elapsedMs - b.elapsedMs || b.rate - a.rate);
    return send(res, 200, { rows: rows.slice(0, 50).map((run) => ({ ...run, build: undefined })) });
  }

  if (method === 'POST' && path === '/api/runs') {
    const player = playerFrom(req);
    if (player === null) return send(res, 401, { error: '先登记昵称' });
    const body = await readJson(req);
    const realm = clampInt(body.realm, 0, 8, -1);
    const elapsedMs = clampInt(body.elapsedMs, 1_000, 86_400_000, -1);
    const seed = clampInt(body.seed, 0, 2_147_483_647, -1);
    const rate = Number(body.rate);
    if (realm < 0 || elapsedMs < 0 || seed < 0 || !Number.isFinite(rate) || rate < 0) {
      return send(res, 400, { error: '成绩字段不合法' });
    }
    const build = typeof body.build === 'string' ? body.build.slice(0, 12_000) : '';
    const previous = db.runs.find((run) => run.playerId === player.id && run.realm === realm);
    const run = { id: id('run'), playerId: player.id, realm, elapsedMs, rate, seed, build, createdAt: now() };
    if (previous === undefined) db.runs.push(run);
    else if (elapsedMs < previous.elapsedMs) Object.assign(previous, run);
    await persist();
    return send(res, 201, { ok: true, run: { ...run, build: undefined } });
  }

  if (method === 'GET' && path === '/api/posts') {
    const sort = url.searchParams.get('sort') === 'new' ? 'new' : 'hot';
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 50);
    const player = playerFrom(req);
    const posts = [...db.posts].sort((a, b) => {
      if (sort === 'new') return b.createdAt - a.createdAt;
      const score = (post) => post.likes.length * 2 + db.comments.filter((comment) => comment.postId === post.id).length * 2;
      return score(b) - score(a) || b.createdAt - a.createdAt;
    }).slice(0, limit);
    return send(res, 200, {
      posts: posts.map((post) => ({ ...publicPost(post), liked: player !== null && post.likes.includes(player.id) })),
    });
  }

  if (method === 'POST' && path === '/api/posts') {
    const player = playerFrom(req);
    if (player === null) return send(res, 401, { error: '先登记昵称' });
    const body = await readJson(req);
    const title = sanitizeText(body.title, 60);
    const text = sanitizeText(body.body, 2000);
    if (title.length < 2 || text.length < 2) return send(res, 400, { error: '标题和正文都要写' });
    const post = {
      id: id('post'),
      authorId: player.id,
      authorName: player.name,
      title,
      body: text,
      build: typeof body.build === 'string' ? body.build.slice(0, 12_000) : '',
      seed: clampInt(body.seed, 0, 2_147_483_647, -1) < 0 ? null : clampInt(body.seed, 0, 2_147_483_647, -1),
      createdAt: now(),
      likes: [],
      flags: [],
    };
    db.posts.push(post);
    await persist();
    return send(res, 201, { post: publicPost(post) });
  }

  const likeMatch = path.match(/^\/api\/posts\/([^/]+)\/like$/u);
  if (method === 'POST' && likeMatch !== null) {
    const player = playerFrom(req);
    if (player === null) return send(res, 401, { error: '先登记昵称' });
    const post = db.posts.find((entry) => entry.id === likeMatch[1]);
    if (post === undefined) return send(res, 404, { error: '帖子不存在' });
    const index = post.likes.indexOf(player.id);
    if (index >= 0) post.likes.splice(index, 1);
    else post.likes.push(player.id);
    await persist();
    return send(res, 200, { likes: post.likes.length, liked: index < 0 });
  }

  const commentMatch = path.match(/^\/api\/posts\/([^/]+)\/comments$/u);
  if (commentMatch !== null) {
    const post = db.posts.find((entry) => entry.id === commentMatch[1]);
    if (post === undefined) return send(res, 404, { error: '帖子不存在' });
    if (method === 'GET') {
      return send(res, 200, { comments: db.comments.filter((comment) => comment.postId === post.id).sort((a, b) => a.createdAt - b.createdAt) });
    }
    if (method === 'POST') {
      const player = playerFrom(req);
      if (player === null) return send(res, 401, { error: '先登记昵称' });
      const body = await readJson(req);
      const text = sanitizeText(body.body, 600);
      if (text.length < 1) return send(res, 400, { error: '评论不能为空' });
      const comment = { id: id('c'), postId: post.id, authorId: player.id, authorName: player.name, body: text, createdAt: now() };
      db.comments.push(comment);
      await persist();
      return send(res, 201, { comment });
    }
  }

  const reportMatch = path.match(/^\/api\/posts\/([^/]+)\/report$/u);
  if (method === 'POST' && reportMatch !== null) {
    const player = playerFrom(req);
    if (player === null) return send(res, 401, { error: '先登记昵称' });
    const post = db.posts.find((entry) => entry.id === reportMatch[1]);
    if (post === undefined) return send(res, 404, { error: '帖子不存在' });
    const body = await readJson(req);
    db.reports.push({ id: id('r'), postId: post.id, playerId: player.id, reason: sanitizeText(body.reason, 200), at: now() });
    post.flags.push(player.id);
    await persist();
    return send(res, 201, { ok: true });
  }

  const deleteMatch = path.match(/^\/api\/posts\/([^/]+)$/u);
  if (method === 'DELETE' && deleteMatch !== null) {
    const player = playerFrom(req);
    const post = db.posts.find((entry) => entry.id === deleteMatch[1]);
    if (post === undefined) return send(res, 404, { error: '帖子不存在' });
    const admin = ADMIN_TOKEN !== '' && req.headers['x-admin-token'] === ADMIN_TOKEN;
    if (!admin && (player === null || post.authorId !== player.id)) return send(res, 403, { error: '只能删自己的帖子' });
    db.posts = db.posts.filter((entry) => entry.id !== post.id);
    db.comments = db.comments.filter((comment) => comment.postId !== post.id);
    await persist();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: '没有这个接口' });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return await serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'bad json' || message === 'body too large') return send(res, 400, { error: '请求体不合法' });
    console.error('[server]', error);
    return send(res, 500, { error: '服务器开小差了' });
  }
});

await loadDb();
server.listen(PORT, () => {
  console.log(`gongfa community server: http://127.0.0.1:${PORT}`);
  console.log(`static: ${WEB_DIST}`);
  console.log(`data:   ${DB_PATH}`);
});
