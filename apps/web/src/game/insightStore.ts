import type { SaveStorage } from '@gongfa/core';

/**
 * 悟道与已学功法（批次 28）：元进度，键与槽位无关。
 * 存档是 A/B 轮换写的，按槽存会在刷新后读到空表（dao/best 都踩过）。
 */
const INSIGHT_KEY = 'gongfa:insight';
const LEARNED_KEY = 'gongfa:learned';

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
