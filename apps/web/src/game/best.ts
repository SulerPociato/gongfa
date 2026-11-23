import type { SaveStorage } from '@gongfa/core';

/**
 * 试炼最佳效率（批次 11）：每个境界记录一条「灵力/步」的历史最好。
 *
 * 为什么值得存：试炼只给一次「蓄势减半」，但玩家真正想知道的是"我这套写法比上次好吗"。
 * 没有基线，60 秒窗口就只是一次性奖励；有基线，它才变成可以反复挑战的分数。
 *
 * 键**不带槽位**（`gongfa:best`）：存档是 A/B 双槽轮换写的，按槽存的话刷新后
 * 指针换到另一边，读到的就是空表（dao 已经踩过一次同样的坑）。
 * 元进度，不进 GameState（契约 §9）。
 */
const BEST_KEY = 'gongfa:best';

export type BestMap = Readonly<Record<number, number>>;

export function readBest(storage: SaveStorage): BestMap {
  const raw = storage.read(BEST_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<number, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const realm = Number(key);
      if (Number.isInteger(realm) && typeof value === 'number' && Number.isFinite(value) && value > 0) {
        out[realm] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeBest(storage: SaveStorage, map: BestMap): void {
  storage.write(BEST_KEY, JSON.stringify(map));
}
