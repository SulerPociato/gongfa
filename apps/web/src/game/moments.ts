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
export type MomentId = 'noise' | 'backlash' | 'sprint' | 'stall' | 'array' | 'art-jade' | 'art-abacus' | 'art-pearl' | 'art-vase' | 'art-pouch';

export const MOMENT_TEXTS: Readonly<Record<MomentId, string>> = {
  noise: '杂念开始了：这一 tick 的产出减半。拖「调息」压住心魔。',
  backlash: '走火入魔：弟子调息 5 秒，期间不产出。',
  sprint: '试炼达成：本境界蓄势减半。',
  stall: '预算用完了：装备算盘可 +50 步，或减少循环层数。',
  // 2026-11-26：金丹解锁引灵/阵图，玩家反馈「只是能找到，不会用」，这里给最短操作路径。
  array: '金丹解锁「引灵 / 阵图」：引灵拖进功法，再把「阵图 N 眼」拖进它的阵位（2 眼 +26% 产出、3 步/次）。也可以在「阵法阁」一键追加到现有功法，不会替换你已有的引灵。',
  // 道具说明卡（评审要求：不要在开局把说明书一次塞给玩家，等它第一次可用时再说）。
  'art-jade': '玉简：同一 tick 内重复的动作产出 ×0.7，但那一步不占预算——要配合循环才划算。',
  'art-abacus': '算盘：每 tick 指令预算 +50 步。程序越深、动作越多，越先撞上限，那时它会明显提速。',
  'art-pearl': '灵珠：全产出 ×1.10。它是乘在最后的，所以速率越高、赚得越多。',
  'art-vase': '玉净瓶：心魔增速 ×0.90。不改产出，只让心魔涨得慢一点——配合「入魔」很好用。',
  'art-pouch': '储物袋：缓存槽位 +1。玉简默认只记得住 1 种动作，交替用吐纳和调息时会被挤掉，它把槽位变成 2 个。',
};

/** 只有这些要"一辈子一次"：其余是事件，同一会话内可以反复发生。 */
export const PERSISTED_MOMENTS: readonly MomentId[] = ['stall', 'array', 'art-jade', 'art-abacus', 'art-pearl', 'art-vase', 'art-pouch'];

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
