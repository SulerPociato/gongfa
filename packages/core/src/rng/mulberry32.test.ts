import { describe, expect, it } from 'vitest';
import type { Rng } from '../types';
import { drawAt, mulberry32 } from './mulberry32';

// 金标值全部由 .qoder/scratch/golden-rng.py（独立实现的纯 Python 32 位整型版本）算出，不是拿本文件反推的。
// 这份口径同时是任务 10 在 balance-sim.py 里复刻杂念规则的依据，所以逐位钉死、不用 toBeCloseTo。
const SEQ: Record<number, readonly number[]> = {
  0: [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086],
  1: [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849],
  12345: [0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203, 0.5094283693470061],
  4294967295: [0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489],
};

function take(rng: Rng, count: number): number[] {
  return Array.from({ length: count }, () => rng.next());
}

describe('mulberry32（架构 §2.6 的 Rng 端口实现）', () => {
  it('逐位等于独立实现的金标序列', () => {
    for (const [seed, expected] of Object.entries(SEQ)) {
      expect(take(mulberry32(Number(seed)), expected.length)).toEqual(expected);
    }
  });

  it('值域 [0,1)：一万个抽样里没有 0 以下的，也没有 1 及以上的', () => {
    const rng = mulberry32(20261119);
    for (const value of take(rng, 10_000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('种子按 uint32 归一：负数与超出 2^32 的种子都落回同一序列', () => {
    // crypto.getRandomValues 给的就是 0..2^32-1，但调试参数能填任意数，语义必须是「取低 32 位」而不是报错
    expect(take(mulberry32(-1), 3)).toEqual(take(mulberry32(4294967295), 3));
    expect(take(mulberry32(0x1_0000_0005), 3)).toEqual(take(mulberry32(5), 3));
    expect(take(mulberry32(0), 3)).toEqual(SEQ[0]?.slice(0, 3));
  });

  it('实例各自独立推进，重建同一序列（回放要的就是这条）', () => {
    const first = mulberry32(77);
    const head = take(first, 2);
    expect(take(first, 2)).not.toEqual(head);
    expect(head).toEqual(take(mulberry32(77), 2));
  });
});

describe('drawAt（按 (seed, index) 定位取数）', () => {
  it('逐位等于金标：seed=1 的前 8 次与第 10 次', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((index) => drawAt(1, index))).toEqual([
      0.1280493459198624, 0.6655411180108786, 0.5498372768051922, 0.7865193742327392,
      0.27561942813917994, 0.41495506814680994, 0.15365864196792245, 0.08314736373722553,
    ]);
    expect(drawAt(1, 10)).toBe(0.4251807371620089);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((index) => drawAt(12345, index))).toEqual([
      0.06251143803820014, 0.38135742978192866, 0.8591396587435156, 0.24844085634686053,
      0.6178865844849497, 0.3893466121517122, 0.9574812506325543, 0.5100397174246609,
    ]);
    expect(drawAt(12345, 10)).toBe(0.2678049807436764);
  });

  it('无状态：调用次数与先后顺序不影响结果（存档里没有 RNG 游标，靠的就是这一点）', () => {
    const before = drawAt(12345, 940);
    drawAt(12345, 1);
    drawAt(999, 940);
    expect(drawAt(12345, 940)).toBe(before);
  });

  it('相邻 index 不相关，且 <0.2 的比例贴近 20%（杂念概率线的抽样下限）', () => {
    expect(drawAt(1, 1)).not.toBe(drawAt(1, 2));
    for (const seed of [7, 12345]) {
      const below = Array.from({ length: 10_000 }, (_, i) => i + 1).filter((index) => drawAt(seed, index) < 0.2).length;
      expect(below / 10_000).toBeGreaterThanOrEqual(0.19);
      expect(below / 10_000).toBeLessThanOrEqual(0.21);
      // 独立实现实测 0.2004 / 0.2020，钉住量级而不是碰运气
      expect(below).toBeLessThan(2100);
    }
  });

  it('换种子就换序列：同一 index 不会所有人一起杂念', () => {
    const at100 = (seed: number) => drawAt(seed, 100);
    expect(new Set([1, 2, 3, 4, 5].map(at100)).size).toBe(5);
  });
});
