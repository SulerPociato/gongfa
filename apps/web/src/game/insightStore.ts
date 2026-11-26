import type { SaveStorage } from '@gongfa/core';

/**
 * 悟道与已学功法（批次 28）：元进度，键与槽位无关。
 * 存档是 A/B 轮换写的，按槽存会在刷新后读到空表（dao/best 都踩过）。
 */
const INSIGHT_KEY = 'gongfa:insight';
const LEARNED_KEY = 'gongfa:learned';
const AWARDED_KEY = 'gongfa:insight:awarded';

export function readInsight(storage: SaveStorage): number {
  const raw = storage.read(INSIGHT_KEY);
  const value = raw === null ? 0 : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function writeInsight(storage: SaveStorage, value: number): void {
  storage.write(INSIGHT_KEY, String(Math.max(0, Math.floor(value))));
}

export function readLearned(storage: SaveStorage): readonly string[] {
  const raw = storage.read(LEARNED_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeLearned(storage: SaveStorage, ids: readonly string[]): void {
  storage.write(LEARNED_KEY, JSON.stringify([...new Set(ids)]));
}

/**
 * 已发放的悟道来源账本（2026-11-26）：`pattern:<id>` / `trial:<realm>`。
 * 只负责「发过一次就别再发」，余额本身仍在 gongfa:insight。
 * 账本与余额同属元进度、不带槽；坏 JSON 回空，最多少补不会重复发。
 */
export function readAwarded(storage: SaveStorage): readonly string[] {
  const raw = storage.read(AWARDED_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeAwarded(storage: SaveStorage, ids: readonly string[]): void {
  storage.write(AWARDED_KEY, JSON.stringify([...new Set(ids)]));
}
