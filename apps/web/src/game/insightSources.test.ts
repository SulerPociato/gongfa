import { describe, expect, it } from 'vitest';
import { insightFromSources, insightValueOf, missingSources, patternSource, sourceIds, trialSource } from './insightSources';

describe('悟道来源（2026-11-26）', () => {
  it('图案/试炼的来源 id 与单值', () => {
    expect(patternSource('linear')).toBe('pattern:linear');
    expect(trialSource(2)).toBe('trial:2');
    expect(insightValueOf('pattern:linear')).toBe(1);
    expect(insightValueOf('trial:2')).toBe(1);
    expect(insightValueOf('unknown:x')).toBe(0);
  });

  it('13 图案 + 4 试炼 = 17 点上限，重复输入只算一次', () => {
    const found = Array.from({ length: 13 }, (_, index) => `p${index}`);
    const ids = sourceIds(found, [0, 1, 2, 3, 2]);
    expect(ids).toHaveLength(17);
    expect(insightFromSources(ids)).toBe(17);
  });

  it('账本差集：只补没发过的', () => {
    const all = sourceIds(['a', 'b'], [0]);
    expect(missingSources(all, [patternSource('a')])).toEqual([patternSource('b'), trialSource(0)]);
    expect(missingSources(all, all)).toEqual([]);
  });

  it('空输入不炸', () => {
    expect(sourceIds([], [])).toEqual([]);
    expect(insightFromSources([])).toBe(0);
    expect(missingSources([], [])).toEqual([]);
  });
});
