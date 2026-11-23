/**
 * 功法谱（批次 23）：每发现一种算法图案，全产出永久 +0.5%。
 *
 * 为什么给产出而不是给新积木：玩家最后都会走到「叠吐纳挂机」，
 * 唯一能让他回头研究算法的东西，是「研究本身有复利」。
 * 上限 13 × 0.5% = 6.5%，压得住平衡（契约 §3 的 11:09 基准仍成立）。
 *
 * 纯函数：数量进、倍率出，方便单测，也方便 HUD 直接显示。
 */
export const INSIGHT_PER_PATTERN = 0.005;

export interface InsightRank {
  /** 达到几个图案时给这个称号。 */
  readonly at: number;
  readonly name: string;
  readonly line: string;
}

export const INSIGHT_RANKS: readonly InsightRank[] = [
  { at: 3, name: '入门', line: '三种写法：顺序、循环、判断，已经能应付大多数问题' },
  { at: 6, name: '小成', line: '开始懂得用条件改变执行路径，而不只是堆数量' },
  { at: 9, name: '通幽', line: '会权衡代价：预算、步数、心魔，三样都在你手里' },
  { at: 13, name: '通晓', line: '功法谱集齐：十三种写法，都是你自己搭出来的' },
];

export function insightRate(foundCount: number): number {
  if (!Number.isFinite(foundCount)) return 1;
  const count = Math.max(0, Math.min(13, Math.round(foundCount)));
  return 1 + count * INSIGHT_PER_PATTERN;
}

export function insightBonusText(foundCount: number): string {
  const percent = Math.round((insightRate(foundCount) - 1) * 1000) / 10;
  return percent === 0 ? '' : `产出 +${percent}%`;
}

/** 刚好达到某个称号时返回它（用于 toast）；否则 null。 */
export function rankReached(before: number, after: number): InsightRank | null {
  return INSIGHT_RANKS.find((rank) => before < rank.at && after >= rank.at) ?? null;
}
