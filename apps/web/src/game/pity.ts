// 「同一境界连续第 N 次冲关」的元进度（2026-11-26）。
// 契约 §7.1 的保底是「连续 3 次必成」，但 attempt 原来只在内存里，刷新一次就回到 1——
// 玩家实际会遇到「连败三次仍不保底」。它不属于 GameState（§5.1 没有这个字段）。
//
// 刻意**不带槽位**：存档 A/B 每 30 秒轮换一次，按槽存会像 `gongfa:dao` 一样在轮换后丢掉
// （§9 里道途不带槽就是同一个理由）。代价是同一浏览器换档会共享保底计数，收益是刷新/换槽都不丢。
import type { SaveStorage } from '@gongfa/core';

export const PITY_KEY = 'gongfa:pity';

export interface PityState {
  readonly realm: number;
  /** 下一次冲关的序号，2..3；1 不落盘（等于没有记录） */
  readonly attempt: number;
}

function parse(raw: string | null): PityState | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as { realm?: unknown; attempt?: unknown };
    const realm = value.realm;
    const attempt = value.attempt;
    if (!Number.isInteger(realm) || (realm as number) < 0) return null;
    if (!Number.isInteger(attempt) || (attempt as number) < 2 || (attempt as number) > 3) return null;
    return { realm: realm as number, attempt: attempt as number };
  } catch {
    return null;
  }
}

/** 读不到 / 坏 JSON / 越界一律当没有记录，不让元进度挡住开局。 */
export function readPity(storage: SaveStorage): PityState | null {
  try {
    return parse(storage.read(PITY_KEY));
  } catch {
    return null;
  }
}

/** attempt <= 1 等于「没有连败」，直接清掉，避免旧记录跟着下一境走。 */
export function writePity(storage: SaveStorage, state: PityState): void {
  try {
    if (state.attempt <= 1) {
      storage.remove(PITY_KEY);
      return;
    }
    storage.write(PITY_KEY, JSON.stringify({ realm: state.realm, attempt: Math.min(3, state.attempt) }));
  } catch {
    // 元进度写失败不影响玩法；下一帧会再试
  }
}

export function clearPity(storage: SaveStorage): void {
  try {
    storage.remove(PITY_KEY);
  } catch {
    // 同上
  }
}
