/**
 * 社区 API 客户端（2026-11-27）。
 * 同源 `/api`：生产由 `server/index.mjs` 托管，开发由 vite proxy 转 8787。
 * 账号 token 存 localStorage；只保存服务端返回的 token，不存密码。
 */
export interface CommunityPlayer {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface LeaderboardRow {
  readonly id: string;
  readonly playerName: string;
  readonly realm: number;
  readonly elapsedMs: number;
  readonly rate: number;
  readonly seed: number;
  readonly createdAt: number;
}

export interface CommunityPost {
  readonly id: string;
  readonly authorName: string;
  readonly title: string;
  readonly body: string;
  readonly build: string;
  readonly seed: number | null;
  readonly createdAt: number;
  readonly likes: number;
  readonly liked: boolean;
  readonly comments: number;
  readonly pinned: boolean;
}

export interface CommunityComment {
  readonly id: string;
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface Account {
  readonly player: CommunityPlayer;
  readonly token: string;
}

const ACCOUNT_KEY = 'gongfa:account';

export function readAccount(): Account | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as { player?: unknown; token?: unknown };
    if (typeof value.token !== 'string' || typeof value.player !== 'object' || value.player === null) return null;
    const player = value.player as { id?: unknown; name?: unknown };
    if (typeof player.id !== 'string' || typeof player.name !== 'string') return null;
    return { player: { id: player.id, name: player.name, createdAt: 0 }, token: value.token };
  } catch {
    return null;
  }
}

export function writeAccount(account: Account): void {
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
}

export function clearAccount(): void {
  localStorage.removeItem(ACCOUNT_KEY);
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return body as T;
}

export function register(name: string): Promise<Account> {
  return request<Account>('/api/register', { method: 'POST', body: JSON.stringify({ name }) });
}

export function fetchLeaderboard(realm: number): Promise<{ rows: LeaderboardRow[] }> {
  return request(`/api/leaderboard?realm=${realm}`);
}

export function fetchPosts(sort: 'hot' | 'new', token?: string): Promise<{ posts: CommunityPost[] }> {
  return request(`/api/posts?sort=${sort}`, {}, token);
}

export function createPost(input: { title: string; body: string; build?: string; seed?: number | null }, token: string): Promise<{ post: CommunityPost }> {
  return request('/api/posts', { method: 'POST', body: JSON.stringify(input) }, token);
}

export function toggleLike(postId: string, token: string): Promise<{ likes: number; liked: boolean }> {
  return request(`/api/posts/${encodeURIComponent(postId)}/like`, { method: 'POST' }, token);
}

export function fetchComments(postId: string): Promise<{ comments: CommunityComment[] }> {
  return request(`/api/posts/${encodeURIComponent(postId)}/comments`);
}

export function createComment(postId: string, body: string, token: string): Promise<{ comment: CommunityComment }> {
  return request(`/api/posts/${encodeURIComponent(postId)}/comments`, { method: 'POST', body: JSON.stringify({ body }) }, token);
}

export function reportPost(postId: string, token: string, reason: string): Promise<{ ok: boolean }> {
  return request(`/api/posts/${encodeURIComponent(postId)}/report`, { method: 'POST', body: JSON.stringify({ reason }) }, token);
}

export function submitRun(input: { realm: number; elapsedMs: number; rate: number; seed: number; build?: string }, token: string): Promise<{ ok: boolean }> {
  return request('/api/runs', { method: 'POST', body: JSON.stringify(input) }, token);
}
