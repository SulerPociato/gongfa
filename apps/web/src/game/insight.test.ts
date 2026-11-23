import { describe, expect, it } from 'vitest';
import { INSIGHT_PER_PATTERN, INSIGHT_RANKS, insightBonusText, insightRate, rankReached } from './insight';

// 功法谱（批次 23）：每发现一种图案 +0.5% 产出，最多 +6.5%。
describe('功法谱加成', () => {
  it('每个图案 0.5%，13 个封顶 6.5%', () => {
    expect(INSIGHT_PER_PATTERN).toBe(0.005);
    expect(insightRate(0)).toBe(1);
    expect(insightRate(1)).toBeCloseTo(1.005, 10);
    expect(insightRate(13)).toBeCloseTo(1.065, 10);
  });

  it('越界不会给出离谱倍率', () => {
    expect(insightRate(-5)).toBe(1);
    expect(insightRate(999)).toBeCloseTo(1.065, 10);
    expect(insightRate(Number.NaN)).toBe(1);
  });

  it('文案按百分比给，0 个时不给空百分比', () => {
    expect(insightBonusText(0)).toBe('');
    expect(insightBonusText(4)).toBe('产出 +2%');
    expect(insightBonusText(13)).toBe('产出 +6.5%');
  });

  it('称号只在「刚好跨过」时触发一次', () => {
    expect(rankReached(2, 3)?.name).toBe('入门');
    expect(rankReached(3, 4)).toBeNull();
    expect(rankReached(12, 13)?.name).toBe('通晓');
    expect(rankReached(0, 13)?.name).toBe('入门');
  });

  it('称号表按门槛升序，最后一个是集齐', () => {
    const ats = INSIGHT_RANKS.map((rank) => rank.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(INSIGHT_RANKS[INSIGHT_RANKS.length - 1]?.at).toBe(13);
  });
});
