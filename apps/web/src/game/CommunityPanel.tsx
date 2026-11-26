import { useEffect, useState } from 'react';
import {
  clearAccount,
  createComment,
  createPost,
  fetchComments,
  fetchLeaderboard,
  fetchPosts,
  readAccount,
  register,
  reportPost,
  submitRun,
  toggleLike,
  writeAccount,
  type Account,
  type CommunityComment,
  type CommunityPost,
  type LeaderboardRow,
} from './communityApi';

export interface CommunityPanelProps {
  readonly realmIndex: number;
  readonly realmName: string;
  readonly seed: number;
  readonly playMs: number;
  readonly rate: number;
  readonly getBuild: () => string;
  readonly onImport: (json: string) => void;
  readonly onClose: () => void;
}

const REALM_NAMES = ['炼气', '筑基', '金丹', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫'] as const;

function formatMs(ms: number): string {  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '0';
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(2)}M`;
  if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)}k`;
  return rate.toFixed(1);
}

export function CommunityPanel({ realmIndex, realmName, seed, playMs, rate, getBuild, onImport, onClose }: CommunityPanelProps) {
  const [account, setAccount] = useState<Account | null>(() => readAccount());
  const [name, setName] = useState('');
  const [tab, setTab] = useState<'board' | 'feed' | 'me'>('board');
  const [board, setBoard] = useState<readonly LeaderboardRow[]>([]);
  const [posts, setPosts] = useState<readonly CommunityPost[]>([]);
  const [sort, setSort] = useState<'hot' | 'new'>('hot');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [attachBuild, setAttachBuild] = useState(false);
  const [openComments, setOpenComments] = useState<string | null>(null);
  const [comments, setComments] = useState<readonly CommunityComment[]>([]);
  const [commentText, setCommentText] = useState('');

  const token = account?.token;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        if (tab === 'board') {
          const data = await fetchLeaderboard(realmIndex);
          if (!cancelled) setBoard(data.rows);
        } else if (tab === 'feed') {
          const data = await fetchPosts(sort, token);
          if (!cancelled) setPosts(data.posts);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [tab, sort, token, realmIndex]);

  const refreshFeed = async (): Promise<void> => {
    try {
      const data = await fetchPosts(sort, token);
      setPosts(data.posts);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '刷新失败');
    }
  };

  const doRegister = async (): Promise<void> => {
    setError('');
    try {
      const created = await register(name);
      writeAccount(created);
      setAccount(created);
      setNotice(`已登记：${created.player.name}`);
      setTab('feed');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登记失败');
    }
  };

  const doSubmitRun = async (): Promise<void> => {
    // 以本机 account 为准：注册后同一拍里点按钮时 state 可能还没刷新。
    const current = account ?? readAccount();
    if (current === null) {
      setError('先登记昵称，才能上榜');
      return;
    }
    setError('');
    try {
      await submitRun({ realm: realmIndex, elapsedMs: Math.max(1_000, Math.round(playMs)), rate, seed, build: getBuild() }, current.token);
      setNotice(`已提交本局成绩：${realmName} · ${formatMs(playMs)}`);
      if (tab === 'board') {
        const data = await fetchLeaderboard(realmIndex);
        setBoard(data.rows);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '提交失败');
    }
  };

  const doPost = async (): Promise<void> => {
    const current = account ?? readAccount();
    if (current === null) {
      setError('先登记昵称，才能发帖');
      return;
    }
    setError('');
    try {
      await createPost({ title, body, build: attachBuild ? getBuild() : '', seed }, current.token);
      setTitle('');
      setBody('');
      setAttachBuild(false);
      setNotice('已发布');
      await refreshFeed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '发布失败');
    }
  };

  const doLike = async (post: CommunityPost): Promise<void> => {
    const current = account ?? readAccount();
    if (current === null) {
      setError('先登记昵称，才能点赞');
      return;
    }
    try {
      const result = await toggleLike(post.id, current.token);
      setPosts((previous) => previous.map((entry) => entry.id === post.id ? { ...entry, likes: result.likes, liked: result.liked } : entry));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '点赞失败');
    }
  };

  const loadComments = async (post: CommunityPost): Promise<void> => {
    if (openComments === post.id) {
      setOpenComments(null);
      return;
    }
    try {
      const data = await fetchComments(post.id);
      setComments(data.comments);
      setOpenComments(post.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '评论加载失败');
    }
  };

  const doComment = async (post: CommunityPost): Promise<void> => {
    const current = account ?? readAccount();
    if (current === null) {
      setError('先登记昵称，才能评论');
      return;
    }
    if (commentText.trim() === '') return;
    try {
      const data = await createComment(post.id, commentText, current.token);
      setComments((previous) => [...previous, data.comment]);
      setCommentText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '评论失败');
    }
  };

  return (
    <div className="community-overlay" onClick={onClose}>
      <section className="community" role="dialog" aria-modal="true" aria-label="社区" onClick={(event) => event.stopPropagation()}>
        <header className="community-head">
          <div>
            <p className="community-title">社区</p>
            <p className="community-sub">{realmName} · 种子 {seed} · 本境 {formatMs(playMs)}</p>
          </div>
          <button className="community-close" type="button" onClick={onClose}>关闭</button>
        </header>

        <div className="community-tabs">
          <button className={tab === 'board' ? 'is-active' : ''} type="button" onClick={() => setTab('board')}>境界榜</button>
          <button className={tab === 'feed' ? 'is-active' : ''} type="button" onClick={() => setTab('feed')}>社区</button>
          <button className={tab === 'me' ? 'is-active' : ''} type="button" onClick={() => setTab('me')}>我的</button>
        </div>

        {error !== '' && <p className="community-error">{error}</p>}
        {notice !== '' && <p className="community-notice">{notice}</p>}

        {tab === 'board' && (
          <div className="community-body">
            <div className="community-row">
              <p className="community-hint">按{realmName}本境最快用时排序；成绩由客户端提交，仅作社区参考。</p>
              <button className="community-primary" type="button" onClick={() => void doSubmitRun()}>提交本局</button>
            </div>
            {loading && <p className="community-hint">加载中…</p>}
            {board.length === 0 && !loading ? <p className="community-hint">还没有人上榜，你可以是第一。</p> : (
              <ol className="board-list">
                {board.map((row, index) => (
                  <li key={row.id} className="board-row">
                    <span className="board-rank">{index + 1}</span>
                    <span className="board-name">{row.playerName}</span>
                    <span className="board-realm">{REALM_NAMES[row.realm] ?? row.realm}</span>
                    <span className="board-time">{formatMs(row.elapsedMs)}</span>
                    <span className="board-rate">{formatRate(row.rate)}/s</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {tab === 'feed' && (
          <div className="community-body">
            <div className="community-row">
              <div className="community-sort">
                <button className={sort === 'hot' ? 'is-active' : ''} type="button" onClick={() => setSort('hot')}>热门</button>
                <button className={sort === 'new' ? 'is-active' : ''} type="button" onClick={() => setSort('new')}>最新</button>
              </div>
              <button className="community-primary" type="button" onClick={() => void refreshFeed()}>刷新</button>
            </div>
            {loading && <p className="community-hint">加载中…</p>}
            <ul className="post-list">
              {posts.map((post) => (
                <li key={post.id} className="post">
                  <div className="post-head">
                    <b>{post.title}</b>
                    <span>{post.authorName}</span>
                  </div>
                  <p className="post-body">{post.body}</p>
                  <div className="post-actions">
                    <button type="button" onClick={() => void doLike(post)}>{post.liked ? '已赞' : '赞'} {post.likes}</button>
                    <button type="button" onClick={() => void loadComments(post)}>评论 {post.comments}</button>
                    {post.build !== '' && <button type="button" onClick={() => onImport(post.build)}>抄作业</button>}
                    {post.seed !== null && <span className="post-seed">种子 {post.seed}</span>}
                    {account !== null && <button className="post-report" type="button" onClick={() => void reportPost(post.id, account.token, '社区举报').then(() => setNotice('已举报')).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : '举报失败'))}>举报</button>}
                  </div>
                  {openComments === post.id && (
                    <div className="post-comments">
                      {comments.map((comment) => (
                        <p key={comment.id}><b>{comment.authorName}</b>：{comment.body}</p>
                      ))}
                      <div className="comment-form">
                        <input value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="说点什么…" maxLength={600} aria-label="评论内容" />
                        <button type="button" onClick={() => void doComment(post)}>发送</button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="post-form">
              <p className="community-hint">发帖（标题 + 正文；可附带当前功法，别人能一键抄）</p>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题" maxLength={60} aria-label="帖子标题" />
              <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="攻略 / 思路 / 问题…" maxLength={2000} rows={4} aria-label="帖子正文" />
              <label className="post-build">
                <input type="checkbox" checked={attachBuild} onChange={(event) => setAttachBuild(event.target.checked)} />
                附带当前功法（别人可「抄作业」）
              </label>
              <button className="community-primary" type="button" onClick={() => void doPost()}>发布</button>
            </div>
          </div>
        )}

        {tab === 'me' && (
          <div className="community-body">
            {account === null ? (
              <div className="community-login">
                <p className="community-hint">登记一个昵称即可上榜、发帖、评论；不需要密码，token 只存在本机。</p>
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="昵称 2–16 位" maxLength={16} aria-label="社区昵称" />
                <button className="community-primary" type="button" onClick={() => void doRegister()}>登记</button>
              </div>
            ) : (
              <div className="community-login">
                <p>当前昵称：<b>{account.player.name}</b></p>
                <p className="community-hint">token 存在本机；换设备需要重新登记。</p>
                <button className="community-secondary" type="button" onClick={() => { clearAccount(); setAccount(null); setNotice('已退出本机账号'); }}>退出本机账号</button>
                <button className="community-primary" type="button" onClick={() => void doSubmitRun()}>提交本局成绩</button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
