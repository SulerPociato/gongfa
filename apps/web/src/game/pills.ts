/**
 * 丹药（2026-11-26）：从图鉴设定变成**可获取、可服用**的库存。
 *
 * 8 种丹药，首次试炼/突破掉落；服用即时生效，不做限时 buff（避免再开一套计时状态）。
 * 库存是元进度 `gongfa:pills`（不带槽，A/B 轮换不丢）。
 */
import type { SaveStorage } from '@gongfa/core';

export type PillEffect =
  | { readonly kind: 'qiPct'; readonly pct: number }
  | { readonly kind: 'demon'; readonly delta: number }
  | { readonly kind: 'clearPause' }
  | { readonly kind: 'charge' };

export interface PillDef {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly effect: PillEffect;
}

export const PILLS: readonly PillDef[] = [
  { id: 'foundationPill', name: '筑基丹', desc: '立刻得到本境阈值 10% 的存量', effect: { kind: 'qiPct', pct: 0.1 } },
  { id: 'marrowPill', name: '洗髓丹', desc: '心魔 -0.20', effect: { kind: 'demon', delta: -0.2 } },
  { id: 'returnYangPill', name: '还阳丹', desc: '立刻得到本境阈值 25% 的存量', effect: { kind: 'qiPct', pct: 0.25 } },
  { id: 'silencePill', name: '寂灭丹', desc: '心魔 -0.50', effect: { kind: 'demon', delta: -0.5 } },
  { id: 'renewPill', name: '结续丹', desc: '立刻结束走火入魔的罚站', effect: { kind: 'clearPause' } },
  { id: 'originYangPill', name: '元阳丹', desc: '立刻得到本境阈值 15% 的存量', effect: { kind: 'qiPct', pct: 0.15 } },
  { id: 'clearPill', name: '清蕴丹', desc: '心魔 -0.40', effect: { kind: 'demon', delta: -0.4 } },
  { id: 'jadeMarrowPill', name: '碧髓丸', desc: '立刻完成本境蓄势（不代替存量）', effect: { kind: 'charge' } },
];

export function pillOf(id: string): PillDef | null {
  return PILLS.find((pill) => pill.id === id) ?? null;
}

/** 按境界掉落：每个境界固定一种，首次到达时发 1 枚。 */
export function pillForRealm(realmIndex: number): PillDef {
  return PILLS[realmIndex % PILLS.length]!;
}

export type PillCounts = Readonly<Record<string, number>>;

const PILL_KEY = 'gongfa:pills';
const PILL_DROP_KEY = 'gongfa:pills:dropped';

/** 首次试炼掉丹按境界只发一次：把「已掉过」记在元进度里，防止刷试炼刷丹。 */
export function claimPillDrop(storage: SaveStorage, realmIndex: number): boolean {
  const raw = storage.read(PILL_DROP_KEY);
  let dropped: number[] = [];
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) dropped = parsed.filter((value): value is number => typeof value === 'number' && Number.isInteger(value));
    } catch {
      dropped = [];
    }
  }
  if (dropped.includes(realmIndex)) return false;
  storage.write(PILL_DROP_KEY, JSON.stringify([...dropped, realmIndex]));
  return true;
}

export function readPills(storage: SaveStorage): PillCounts {
  const text = storage.read(PILL_KEY);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const pill of PILLS) {
      const value = (parsed as Record<string, unknown>)[pill.id];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 1) out[pill.id] = Math.floor(value);
    }
    return out;
  } catch {
    return {};
  }
}

export function writePills(storage: SaveStorage, counts: PillCounts): void {
  storage.write(PILL_KEY, JSON.stringify(counts));
}

export function grantPill(storage: SaveStorage, id: string, amount = 1): PillCounts {
  const counts = { ...readPills(storage) };
  counts[id] = (counts[id] ?? 0) + Math.max(1, Math.floor(amount));
  writePills(storage, counts);
  return counts;
}

export function consumePill(storage: SaveStorage, id: string): PillCounts | null {
  const counts = { ...readPills(storage) };
  if ((counts[id] ?? 0) <= 0) return null;
  if (counts[id] === 1) delete counts[id];
  else counts[id] = counts[id]! - 1;
  writePills(storage, counts);
  return counts;
}

/** UI 一行。count 为 0 也显示，玩家知道有这种东西、去哪里拿。 */
export interface PillRow {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly count: number;
}
