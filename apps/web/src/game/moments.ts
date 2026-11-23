import type { SaveStorage } from '@gongfa/core';
import { activeSlot } from '@gongfa/core';

/**
 * 批次 5：一次性"关键时刻"提示。
 *
 * 这四个 moment 和境界解锁共用同一条 toast 队列（App.tsx 的 unlockToasts），
 * 但语义不同：解锁是"新东西出现"，moment 是"刚才发生了什么"。
 * 共同点是都必须等结果层（outcome）消失后再播，否则会被渡劫动画盖住。
 *
 * 文案里的数字一律由调用方现取（剩余蓄势、预算上限等），表里只放固定句式，
 * 避免第二天改了数值、提示还在说旧话。
 */
export type MomentId = 'noise' | 'backlash' | 'sprint' | 'stall';

export const MOMENT_TEXTS: Readonly<Record<MomentId, string>> = {
  noise: '杂念开始了：这一 tick 的产出减半。拖「调息」压住心魔。',
  backlash: '走火入魔：弟子调息 5 秒，期间不产出。',
  sprint: '试炼达成：本境界蓄势减半。',
  stall: '预算用完了：装备算盘可 +50 步，或减少循环层数。',
};

/** 只有 stall 要"一辈子一次"：其余三个是事件，同一会话内可以反复发生。 */
export const PERSISTED_MOMENTS: readonly MomentId[] = ['stall'];

const SEEN_PREFIX = 'gongfa:seen:';

export function seenKey(slot: 'A' | 'B'): string {
  return `${SEEN_PREFIX}${slot}`;
}

export function readSeen(storage: SaveStorage, slot: 'A' | 'B'): readonly string[] {
  const raw = storage.read(seenKey(slot));
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function writeSeen(storage: SaveStorage, slot: 'A' | 'B', ids: readonly string[]): void {
  storage.write(seenKey(slot), JSON.stringify(ids));
}

/** 当前活动槽位上的"已经播过"集合；槽位拿不到时退回 A，和存档同一条路由。 */
export function readSeenActive(storage: SaveStorage): readonly string[] {
  return readSeen(storage, activeSlot(storage));
}
