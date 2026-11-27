// Qoder Sites Function backend：社区 API（2026-11-27）
// 与 server/index.mjs 的业务语义一致；身份使用应用自己的 token，不依赖 Qoder 登录。
// 该目录由 Qoder 平台注入 _qoder/backend.mjs；不要在 functions/ 里创建 _qoder。

const SEEDS = [
  { id: 'seed-1', title: '新人第一课：循环比多叠吐纳更划算', body: '先把「吐纳」拖进「每 tick」，再用「循环 3 次」包住它：同样的动作数，步数更少。筑基后给循环配玉简，重复动作会打折但省步。别一上来就堆十块吐纳，预算会先撞墙。' },
  { id: 'seed-2', title: '阵法的正确用法：只追加，不替换', body: '金丹后去「阵法阁」点「拓印到现有功法」：它只接在「每 tick」链尾，不会动你已有的引灵。想自己搭，就把「引灵」拖进功法，再把「阵图 N 眼」拖进它的阵位。2 眼 +26%，但每次多走 3 步。' },
  { id: 'seed-3', title: '九境路线：化神之后怎么走', body: '炼气→筑基→金丹→元婴→化神→炼虚→合体→大乘→渡劫。前四境约 11 分钟；化神起每境更慢，蓄势 8/12/18/25/30 分钟。元婴之后宗门/界域和丹药会明显影响节奏。' },
  { id: 'seed-4', title: '宗门/界域怎么选：看你要产出还是稳', body: '仙剑门、天机阁偏产出；万佛宗、菩提学院压心魔；魔道宗门产出高但心魔也高。界域同理：鬼域/魔域是高风险高产出，海域/云之法界更稳。选错了可以改，不用重开档。' },
  { id: 'seed-5', title: '丹药别囤：什么时候吃', body: '首次试炼每个境界掉一枚丹。筑基丹/元阳丹补存量，洗髓丹/清蕴丹压心魔，结续丹解走火罚站，碧髓丸直接完成蓄势。它们不占丹炉 45 秒冷却，该吃就吃。' },
  { id: 'seed-6', title: '社区规则（暂行）', body: '只聊游戏与算法；不发自认侵权/广告/人身攻击内容；剧透标一下。举报进管理员队列。榜单成绩由客户端提交，只作社区参考。' },
];

export function application({ db, BackendError }) {
  const fail = (code, status) => { throw new BackendError(code, status); };
  const rows = (result) => {
    if (result.error) fail(result.error.code, result.error.status);
    return result.data ?? [];
  };
  const one = (result) => rows(result)[0];

  async function jsonBody(request, max = 64 * 1024) {
    if (!request.headers.get('content-type')?.startsWith('application/json')) fail('invalid_input', 400);
    const reader = request.body?.getReader();
    if (!reader) fail('invalid_input', 400);
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { await reader.cancel(); fail('payload_too_large', 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('invalid_input', 400); }
  }

  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : null;

  async function tokenHash(token) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function currentPlayer(request) {
    const direct = request.headers.get('x-gongfa-token') ?? '';
    const header = request.headers.get('authorization') ?? '';
    const token = direct.length >= 20 ? direct : (header.startsWith('Bearer ') ? header.slice(7) : '');
    if (token.length < 20) return null;
    const found = one(await db.from('players').select('id,name,created_at').eq('token_hash', await tokenHash(token)).limit(1));
    return found ?? null;
  }

  async function requirePlayer(request) {
    const player = await currentPlayer(request);
    if (player === null) fail('login_required', 401);
    return player;
  }

  async function seedPosts() {
    for (const seed of SEEDS) {
      rows(await db.from('posts').insertIfAbsent({
        id: seed.id,
        author_id: 'system',
        author_name: '天机阁',
        title: seed.title,
        body: seed.body,
        build: '',
        seed: null,
      }, { onConflict: 'id' }));
    }
  }

  const time = (value) => {
    const ms = typeof value === 'string' ? Date.parse(value) : Number(value);
    return Number.isFinite(ms) ? ms : Date.now();
  };

  const postView = (post, likes, comments, playerId) => ({
    id: post.id,
    authorName: post.author_name,
    title: post.title,
    body: post.body,
    build: post.build ?? '',
    seed: post.seed === null || post.seed === undefined ? null : Number(post.seed),
    createdAt: time(post.created_at),
    likes: likes.length,
    liked: playerId !== null && likes.some((like) => like.player_id === playerId),
    comments: comments.length,
    pinned: post.id === 'seed-1',
  });

  return async (ctx) => {
    const request = ctx.request;
    const pathname = new URL(request.url).pathname;
    const match = pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/u);
    if (!match) fail('not_found', 404);
    const path = match[1] || '/';
    const method = request.method;

    if (method === 'GET' && path === '/api/health') {
      return Response.json({ ok: true });
    }

    if (method === 'POST' && path === '/api/register') {
      const body = await jsonBody(request);
      const name = text(body.name, 16);
      if (!/^[\p{L}\p{N}_-]{2,16}$/u.test(name)) fail('invalid_input', 400);
      const existing = one(await db.from('players').select('id').eq('name', name).limit(1));
      if (existing) fail('name_taken', 409);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const player = { id: `p_${crypto.randomUUID()}`, name, token_hash: await tokenHash(token), created_at: new Date().toISOString() };
      rows(await db.from('players').insert(player));
      return Response.json({ player: { id: player.id, name, createdAt: time(player.created_at) }, token }, { status: 201 });
    }

    if (method === 'GET' && path === '/api/me') {
      const player = await requirePlayer(request);
      return Response.json({ player: { id: player.id, name: player.name, createdAt: time(player.created_at) } });
    }

    if (method === 'GET' && path === '/api/leaderboard') {
      const realm = integer(Number(new URL(request.url).searchParams.get('realm')), 0, 8) ?? 2;
      const runs = rows(await db.from('runs').select('id,player_id,realm,elapsed_ms,rate,seed,created_at').eq('realm', realm).order('elapsed_ms', { ascending: true }).limit(50));
      const players = rows(await db.from('players').select('id,name'));
      const names = new Map(players.map((player) => [player.id, player.name]));
      return Response.json({
        rows: runs.map((run) => ({
          id: run.id,
          playerName: names.get(run.player_id) ?? '无名',
          realm: Number(run.realm),
          elapsedMs: Number(run.elapsed_ms),
          rate: Number(run.rate),
          seed: Number(run.seed),
          createdAt: time(run.created_at),
        })),
      });
    }

    if (method === 'POST' && path === '/api/runs') {
      const player = await requirePlayer(request);
      const body = await jsonBody(request);
      const realm = integer(body.realm, 0, 8);
      const elapsedMs = integer(body.elapsedMs, 1000, 86_400_000);
      const seed = integer(body.seed, 0, 2_147_483_647);
      const rate = Number(body.rate);
      if (realm === null || elapsedMs === null || seed === null || !Number.isFinite(rate) || rate < 0) fail('invalid_input', 400);
      const build = text(body.build, 12_000);
      const previous = one(await db.from('runs').select('id,elapsed_ms').eq('player_id', player.id).eq('realm', realm).limit(1));
      if (!previous) {
        rows(await db.from('runs').insert({ id: `run_${crypto.randomUUID()}`, player_id: player.id, realm, elapsed_ms: elapsedMs, rate, seed, build, created_at: new Date().toISOString() }));
      } else if (elapsedMs < Number(previous.elapsed_ms)) {
        rows(await db.from('runs').update({ elapsed_ms: elapsedMs, rate, seed, build, created_at: new Date().toISOString() }).eq('id', previous.id));
      }
      return Response.json({ ok: true }, { status: 201 });
    }

    if (method === 'GET' && path === '/api/posts') {
      await seedPosts();
      const player = await currentPlayer(request);
      const posts = rows(await db.from('posts').select('id,author_id,author_name,title,body,build,seed,created_at').order('created_at', { ascending: false }).limit(100));
      const likes = rows(await db.from('post_likes').select('post_id,player_id'));
      const comments = rows(await db.from('comments').select('post_id'));
      const sort = new URL(request.url).searchParams.get('sort') === 'new' ? 'new' : 'hot';
      const mapped = posts.map((post) => ({
        post,
        view: postView(post, likes.filter((like) => like.post_id === post.id), comments.filter((comment) => comment.post_id === post.id), player?.id ?? null),
      }));
      if (sort === 'hot') mapped.sort((a, b) => (b.view.likes * 2 + b.view.comments * 2) - (a.view.likes * 2 + a.view.comments * 2) || b.view.createdAt - a.view.createdAt);
      return Response.json({ posts: mapped.map((item) => item.view) });
    }

    if (method === 'POST' && path === '/api/posts') {
      const player = await requirePlayer(request);
      const body = await jsonBody(request);
      const title = text(body.title, 60);
      const content = text(body.body, 2000);
      if (title.length < 2 || content.length < 2) fail('invalid_input', 400);
      const seed = integer(body.seed, 0, 2_147_483_647);
      const post = {
        id: `post_${crypto.randomUUID()}`,
        author_id: player.id,
        author_name: player.name,
        title,
        body: content,
        build: text(body.build, 12_000),
        seed,
        created_at: new Date().toISOString(),
      };
      rows(await db.from('posts').insert(post));
      return Response.json({ post: postView(post, [], [], player.id) }, { status: 201 });
    }

    const likeMatch = path.match(/^\/api\/posts\/([^/]+)\/like$/u);
    if (method === 'POST' && likeMatch) {
      const player = await requirePlayer(request);
      const postId = likeMatch[1];
      const existing = one(await db.from('post_likes').select('post_id').eq('post_id', postId).eq('player_id', player.id).limit(1));
      if (existing) rows(await db.from('post_likes').delete().eq('post_id', postId).eq('player_id', player.id));
      else rows(await db.from('post_likes').insert({ post_id: postId, player_id: player.id, created_at: new Date().toISOString() }));
      const likes = rows(await db.from('post_likes').select('post_id').eq('post_id', postId));
      return Response.json({ likes: likes.length, liked: !existing });
    }

    const commentMatch = path.match(/^\/api\/posts\/([^/]+)\/comments$/u);
    if (commentMatch) {
      const postId = commentMatch[1];
      if (method === 'GET') {
        const comments = rows(await db.from('comments').select('id,author_name,body,created_at').eq('post_id', postId).order('created_at', { ascending: true }).limit(200));
        return Response.json({ comments: comments.map((comment) => ({ ...comment, createdAt: time(comment.created_at) })) });
      }
      if (method === 'POST') {
        const player = await requirePlayer(request);
        const body = await jsonBody(request);
        const content = text(body.body, 600);
        if (content.length < 1) fail('invalid_input', 400);
        const comment = { id: `c_${crypto.randomUUID()}`, post_id: postId, author_id: player.id, author_name: player.name, body: content, created_at: new Date().toISOString() };
        rows(await db.from('comments').insert(comment));
        return Response.json({ comment: { ...comment, createdAt: time(comment.created_at) } }, { status: 201 });
      }
    }

    const reportMatch = path.match(/^\/api\/posts\/([^/]+)\/report$/u);
    if (method === 'POST' && reportMatch) {
      const player = await requirePlayer(request);
      const body = await jsonBody(request);
      rows(await db.from('reports').insert({ id: `r_${crypto.randomUUID()}`, post_id: reportMatch[1], player_id: player.id, reason: text(body.reason, 200), created_at: new Date().toISOString() }));
      return Response.json({ ok: true }, { status: 201 });
    }

    const deleteMatch = path.match(/^\/api\/posts\/([^/]+)$/u);
    if (method === 'DELETE' && deleteMatch) {
      const player = await requirePlayer(request);
      const post = one(await db.from('posts').select('id,author_id').eq('id', deleteMatch[1]).limit(1));
      if (!post) fail('not_found', 404);
      if (post.author_id !== player.id) fail('forbidden', 403);
      rows(await db.from('posts').delete().eq('id', post.id));
      rows(await db.from('comments').delete().eq('post_id', post.id));
      rows(await db.from('post_likes').delete().eq('post_id', post.id));
      return Response.json({ ok: true });
    }

    fail('not_found', 404);
  };
}
