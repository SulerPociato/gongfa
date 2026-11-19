import { describe, expect, it } from 'vitest';
import {
  BACKLASH_LINE,
  BACKLASH_PAUSE_MS,
  BACKLASH_QI_MULT,
  NOISE_CHANCE,
  NOISE_GAIN_MULT,
  NOISE_LINE,
  NOISE_ROLL_PERIOD,
  applyBacklash,
  noiseGainMult,
  reachesBacklash,
} from './rules';

// 开局程序（每 tick → 吐纳）无循环 → loopDepth 0 → 每 tick 心魔增长 0.00005；无书 → demonMult 1。
const GROWTH_PER_TICK = 0.00005;
const SEED = 1;
const WINDOW_TICKS = 1200; // 120 秒

// 命中列表由 .qoder/scratch/golden-rng.py 独立算出（34 次 / 120 次 roll），本文件不自己造随机口径。
const PREDICTED_NOISE_TICKS = [
  80, 100, 140, 210, 310, 420, 440, 450, 480, 550, 580, 610, 640, 660, 700, 730, 740, 750, 780, 810, 830, 840, 860, 870,
  900, 910, 920, 960, 990, 1050, 1090, 1100, 1150, 1200,
];

function noiseTicks(demon: number, seed: number, lastTick: number): number[] {
  const hits: number[] = [];
  for (let tick = 1; tick <= lastTick; tick++) {
    if (noiseGainMult({ demon, seed, tick }) === NOISE_GAIN_MULT) hits.push(tick);
  }
  return hits;
}

describe('心魔阈值常量（01-design §4.4 的规则表）', () => {
  it('0.5 调息线不在这里：本模块只管 >0.7 杂念与 =1.0 走火', () => {
    expect(NOISE_LINE).toBe(0.7);
    expect(NOISE_CHANCE).toBe(0.2);
    expect(NOISE_GAIN_MULT).toBe(0.5);
    expect(NOISE_ROLL_PERIOD).toBe(10); // 每秒 roll 一次（TICKS_PER_SEC=10）
    expect(BACKLASH_LINE).toBe(1);
    expect(BACKLASH_QI_MULT).toBe(0.7);
    expect(BACKLASH_PAUSE_MS).toBe(5000);
  });
});

describe('杂念：>0.7 时每秒 20% 概率，命中则本 tick 产出 ×0.5', () => {
  it('未过线一律不砍，也一次随机都不取（0.7 本身不算过线，规则是严格大于）', () => {
    for (const demon of [0, 0.5, 0.6999999, 0.7]) {
      for (let tick = 1; tick <= WINDOW_TICKS; tick++) {
        expect(noiseGainMult({ demon, seed: SEED, tick })).toBe(1);
      }
    }
  });

  it('只在每秒那一次 roll 上判定：非 roll tick 永远拿满产出', () => {
    for (let tick = 1; tick <= WINDOW_TICKS; tick++) {
      if (tick % NOISE_ROLL_PERIOD === 0) continue;
      expect(noiseGainMult({ demon: 0.999999, seed: SEED, tick })).toBe(1);
    }
  });

  it('demon=0.75 起，120 秒内的命中 tick 列表逐位等于独立实现的预测', () => {
    expect(noiseTicks(0.75, SEED, WINDOW_TICKS)).toEqual(PREDICTED_NOISE_TICKS);
  });

  it('概率量级对得上 20%：seed=1 命中 34/120，seed=12345 命中 28/120', () => {
    expect(noiseTicks(0.75, 1, WINDOW_TICKS).length).toBe(34);
    expect(noiseTicks(0.75, 12345, WINDOW_TICKS)).toEqual([
      40, 230, 250, 300, 370, 450, 560, 620, 660, 670, 780, 790, 800, 810, 820, 850, 870, 880, 890, 910, 920, 950, 1050,
      1070, 1130, 1150, 1180, 1190,
    ]);
    expect(noiseTicks(0.75, 987654321, WINDOW_TICKS)).toEqual([
      150, 180, 300, 330, 380, 390, 470, 480, 590, 620, 660, 750, 790, 820, 1010, 1030, 1040, 1140, 1180,
    ]);
  });

  it('换种子换序列；同种子重跑逐 tick 一致（验收 5 的口径）', () => {
    expect(noiseTicks(0.75, 987654321, WINDOW_TICKS)).not.toEqual(PREDICTED_NOISE_TICKS);
    expect(noiseTicks(0.75, SEED, WINDOW_TICKS)).toEqual(noiseTicks(0.75, SEED, WINDOW_TICKS));
  });

  it('只作用于产出乘数：返回值就是乘数，砍不砍由调用方乘在 result.gain 上（境界被动不砍，契约 §2.3）', () => {
    const mults = new Set<number>();
    for (let tick = 1; tick <= WINDOW_TICKS; tick++) mults.add(noiseGainMult({ demon: 0.9, seed: SEED, tick }));
    expect([...mults].sort()).toEqual([0.5, 1]);
  });
});

describe('走火入魔：心魔到 1.0 → 存量 ×0.7、心魔归 0、停 5 秒', () => {
  it('夹紧前判 crossings：只用二进制精确的数钉语义，不靠舍入', () => {
    expect(reachesBacklash(0.5, 0.5)).toBe(true);
    expect(reachesBacklash(0.75, 0.25)).toBe(true);
    expect(reachesBacklash(0.99995, 0.00005)).toBe(true);
    expect(reachesBacklash(0.25, 0.5)).toBe(false);
    expect(reachesBacklash(0.9, 0.00005)).toBe(false);
  });

  it('调息把心魔拉回 1.0 以下就不触发（负 delta 不能被当成「还在 1.0 上」）', () => {
    expect(reachesBacklash(0.75, -0.5)).toBe(false);
    expect(reachesBacklash(0.9999, -0.0005)).toBe(false);
  });

  it('已经站在 1.0 上（?demon=1 或改档）下一 tick 立刻走火，不再等到「越过」', () => {
    expect(reachesBacklash(1, -0.0005)).toBe(true);
    expect(reachesBacklash(1, 0)).toBe(true);
  });

  it('开局单吐纳 + ?demon=0.99 → 恰好在 tick 201 走火（验收 4 的预言）', () => {
    let demon = 0.99;
    let tick = 0;
    let fired = 0;
    while (fired === 0 && tick < 1000) {
      tick += 1;
      fired = reachesBacklash(demon, GROWTH_PER_TICK) ? tick : 0;
      demon = Math.min(1, demon + GROWTH_PER_TICK);
    }
    expect(tick).toBe(201);
    expect(fired).toBe(201);
  });

  it('存量 ×0.7：整数存量的乘积仍精确', () => {
    expect(applyBacklash(1000)).toBe(700);
    expect(applyBacklash(2_500_000)).toBe(1_750_000);
    expect(applyBacklash(1)).toBe(0.7);
    expect(applyBacklash(0)).toBe(0);
  });
});
