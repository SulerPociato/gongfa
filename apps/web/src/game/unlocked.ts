import type { SaveStorage } from '@gongfa/core';

// 批次 5：境界解锁的块提示记录（任务 8 续）。
// 与 gongfa:found:${slot} 同命名空间，按槽隔离：B 档不该看到 A 档的解锁提示。
// 键名 = `gongfa:unlocked:${slot}`，值是 JSON 数组（string[]），解析失败回空集（不崩页面）。

const NAMESPACE = 'gongfa:unlocked:';

export function unlockedKey(slot: 'A' | 'B'): string {
  return `${NAMESPACE}${slot}`;
}

/**
 * 读当前活动槽的解锁提示记录。
 * 指针缺失 / JSON 解析失败 / 数组里有未知类型 → 一律回空集（不抛、不报红字）。
 * 坏档可以接受，整页崩掉不行（与 storage.ts 的兜底哲学一致）。
 */
export function readUnlocked(storage: SaveStorage, slot: 'A' | 'B'): readonly string[] {
  const text = storage.read(unlockedKey(slot));
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/**
 * 写解锁提示记录。宿主在境界变化且有新块解锁时调用，传入新的完整集合（不是增量）。
 * 写入失败（配额满）不抛：下次解锁时会再试一次，玩家最多晚几秒看到提示。
 */
export function writeUnlocked(storage: SaveStorage, slot: 'A' | 'B', ids: readonly string[]): void {
  storage.write(unlockedKey(slot), JSON.stringify(ids));
}
