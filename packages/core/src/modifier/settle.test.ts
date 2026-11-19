import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/loader';
import type { JadeCacheSpec } from '../content/artifacts';
import type { Modifier } from '../content/books';
import type { ActionRequest } from '../vm/interpreter';
import { actionMult, makeActionSink, resolveModifiers } from './settle';

// 契约 §2.4 的玉简：数值一律来自 content/artifacts.json，这里同值内联，避免测试依赖表文件。
const JADE: JadeCacheSpec = { sameActionId: true, hitGainMultiplier: 0.7, hitStepCost: 0 };

const CONTENT = loadContent({
  actions: [
    { id: 'breath', baseGain: 1, demonDelta: 0, kind: 'gain' },
    { id: 'calm', baseGain: 0, demonDelta: -0.0005, kind: 'calm' },
  ],
  realms: [
    { id: 0, name: { zh: '炼气' }, threshold: '1e3', passivePerSec: 0, actionMult: 1 },
    { id: 1, name: { zh: '筑基' }, threshold: '2e4', passivePerSec: 5, actionMult: 3 },
  ],
});

function req(actionId: string, k: number, loopDepth = 0): ActionRequest {
  return { actionId, k, pc: 0, loopDepth };
}

describe('makeActionSink（契约 §2.1 / §2.2）', () => {
  it('k 递增驱动边际递减', () => {
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0 });
    const gains = [1, 2, 3, 4].map((k) => sink.execute(req('breath', k)).qi);
    expect(gains[0]).toBe(1);
    expect(gains[1]).toBeCloseTo(0.8, 12);
    expect(gains[2]).toBeCloseTo(1 / 1.5, 12);
    expect(gains[3]).toBeCloseTo(1 / 1.75, 12);
    // 独立复核 §2.2 表值，不复用 sink 内部实现
    expect(actionMult(10)).toBeCloseTo(1 / 3.25, 12);
  });

  it('realmActionMult 生效：筑基 ×3', () => {
    const sink = makeActionSink({ content: CONTENT, realmIndex: 1 });
    expect(sink.execute(req('breath', 1)).qi).toBeCloseTo(3, 12);
    expect(sink.execute(req('breath', 2)).qi).toBeCloseTo(2.4, 12);
    expect(() => makeActionSink({ content: CONTENT, realmIndex: 9 })).toThrow(RangeError);
  });

  it('同 tick 内重复 actionId 可观察；装玉简后第 2 次起 ×0.7 且仍吃 actionMult', () => {
    const plain = makeActionSink({ content: CONTENT, realmIndex: 0 });
    expect(plain.execute(req('breath', 1)).qi).toBe(1);
    expect(plain.execute(req('breath', 2)).qi).toBeCloseTo(0.8, 12);
    expect(plain.observed.repeats).toBe(1);

    const jade = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: JADE });
    expect(jade.execute(req('breath', 1)).qi).toBe(1);
    expect(jade.execute(req('breath', 2)).qi).toBeCloseTo(0.8 * 0.7, 12);
    expect(jade.observed.repeats).toBe(1);
  });

  it('k 回到 1 就是新 tick：重复集合清空', () => {
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0 });
    sink.execute(req('breath', 1));
    sink.execute(req('breath', 2)); // 本 tick 第 2 次 breath → 重复
    sink.execute(req('breath', 1)); // 下一 tick 第 1 次 → 不算重复
    expect(sink.observed.repeats).toBe(1);
    expect(sink.execute(req('breath', 2)).qi).toBeCloseTo(0.8, 12);
  });

  it('demonDelta = 表值 + §2.2.1 增长；未知 actionId 抛错', () => {
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0 });
    // breath 表里 demonDelta=0，增长 0.00005×(1+0.5×0)
    expect(sink.execute(req('breath', 1)).demonDelta).toBeCloseTo(0.00005, 12);
    // calm 表里 -0.0005，kind≠gain 不增长
    expect(sink.execute(req('calm', 2)).demonDelta).toBeCloseTo(-0.0005, 12);
    expect(() => sink.execute(req('herb', 1))).toThrow(RangeError);
  });

  it('§2.2.1 增长随 loopDepth：0→0.00005，1→0.000075，2→0.0001', () => {
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0 });
    const at = (loopDepth: number) => sink.execute(req('breath', 1, loopDepth)).demonDelta;
    expect(at(0)).toBeCloseTo(0.00005, 12);
    expect(at(1)).toBeCloseTo(0.00005 * 1.5, 12);
    expect(at(2)).toBeCloseTo(0.0001, 12);
  });

  it('调息在任何深度都不增长，只保留表里的 -0.0005', () => {
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0 });
    expect(sink.execute(req('calm', 1, 3)).demonDelta).toBeCloseTo(-0.0005, 12);
    expect(sink.execute(req('calm', 2, 8)).demonDelta).toBeCloseTo(-0.0005, 12);
  });

  it('demonBase 可注入（任务 10 要跑 0.00004 / 0.00005 两档）', () => {
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0, demonBase: 0.00004 });
    expect(sink.execute(req('breath', 1, 1)).demonDelta).toBeCloseTo(0.00004 * 1.5, 12);
  });
});

const ZHOUTIAN: Modifier = { id: 'zhoutian_demon', target: 'demonRate', kind: 'mul', value: 0.95 };

describe('功法书结算（契约 §6 + 架构 §4「先加后乘」，任务 5B）', () => {
  it('不传 bookDecay / modifiers 时逐值等于 5A', () => {
    const plain = makeActionSink({ content: CONTENT, realmIndex: 0 });
    expect(plain.execute(req('breath', 1))).toEqual({ qi: 1, demonDelta: 0.00005 });
    // 显式传中性档（卸下书走的就是这条）必须与不传完全一致，否则「成对移除」只是名义上移除
    const explicit = makeActionSink({ content: CONTENT, realmIndex: 0, bookDecay: 1, modifiers: [] });
    expect(explicit.execute(req('breath', 2))).toEqual(plain.execute(req('breath', 2)));
  });

  it('bookDecay 只作用动作 qi，不碰 demonDelta', () => {
    const plain = makeActionSink({ content: CONTENT, realmIndex: 1 }).execute(req('breath', 1));
    const decayed = makeActionSink({ content: CONTENT, realmIndex: 1, bookDecay: 2 / 3 }).execute(req('breath', 1));
    expect(plain.qi).toBeCloseTo(3, 12);
    expect(decayed.qi).toBeCloseTo(2, 12);
    expect(decayed.demonDelta).toBe(plain.demonDelta);
  });

  it('demonRate ×0.95 按 O1：(动作自身 + 增长项) × 乘数，衰减不参与', () => {
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0, bookDecay: 0.5, modifiers: [ZHOUTIAN] });
    // breath 表 0 + §2.2.1 增长 0.00005×1.5（loopDepth 1）= 0.000075，再 ×0.95
    expect(sink.execute(req('breath', 1, 1)).demonDelta).toBeCloseTo(0.000075 * 0.95, 12);
    // calm 表 -0.0005、kind≠gain 不增长：负值同样先加后乘
    expect(sink.execute(req('calm', 2)).demonDelta).toBeCloseTo(-0.0005 * 0.95, 12);
    // qi 侧只吃 decay：1 × actionMult(3) × 0.5，书衰减不放大心魔
    expect(sink.execute(req('breath', 3)).qi).toBeCloseTo((1 / 1.5) * 0.5, 12);
  });

  it('rate 修饰与衰减同链相乘：筑基 ×3 × 衰减 0.75 × 修饰 2', () => {
    const sink = makeActionSink({
      content: CONTENT,
      realmIndex: 1,
      bookDecay: 0.75,
      modifiers: [{ id: 'shuang', target: 'rate', kind: 'mul', value: 2 }],
    });
    expect(sink.execute(req('breath', 1)).qi).toBeCloseTo(3 * 0.75 * 2, 12);
  });

  it('budget / offlineRate / slot 在 5B 只收不消费：数值不动，只进 ignored', () => {
    const mods: Modifier[] = [
      { id: 'b', target: 'budget', kind: 'add', value: 50 },
      { id: 'o', target: 'offlineRate', kind: 'mul', value: 0.5 },
      { id: 's', target: 'slot', kind: 'add', value: 1 },
    ];
    const resolved = resolveModifiers(mods);
    expect(resolved.rateMult).toBe(1);
    expect(resolved.demonMult).toBe(1);
    expect(resolved.add).toEqual({ rate: 0, demonRate: 0, budget: 50, offlineRate: 0, slot: 1 });
    expect(resolved.ignored).toEqual(['b', 'o', 's']);
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0, modifiers: mods });
    expect(sink.execute(req('breath', 1))).toEqual({ qi: 1, demonDelta: 0.00005 });
  });

  it('重复装备 / 负值 / 上限（架构 §4 点名的三种情况）', () => {
    expect(resolveModifiers([])).toEqual({ rateMult: 1, demonMult: 1, add: { rate: 0, demonRate: 0, budget: 0, offlineRate: 0, slot: 0 }, ignored: [] });
    // 同 id 后装者胜：重复装备同一本不叠加
    expect(resolveModifiers([
      { id: 'dup', target: 'rate', kind: 'add', value: 0.5 },
      { id: 'dup', target: 'rate', kind: 'add', value: 1.2 },
    ]).rateMult).toBeCloseTo(2.2, 12);
    // 负值 add：乘数夹到 0，绝不出现负产出
    expect(resolveModifiers([{ id: 'neg', target: 'rate', kind: 'add', value: -3 }]).rateMult).toBe(0);
    // mul 传负数是坏表：整条丢弃并记进 ignored，不静默反向
    const bad = resolveModifiers([{ id: 'oops', target: 'rate', kind: 'mul', value: -1 }]);
    expect(bad.rateMult).toBe(1);
    expect(bad.ignored).toEqual(['oops']);
    // 上限：rate 乘积先 3×4=12，加 9 之后仍夹在 5；demon 乘积夹 3
    expect(resolveModifiers([
      { id: 'a', target: 'rate', kind: 'mul', value: 3 },
      { id: 'b', target: 'rate', kind: 'mul', value: 4 },
      { id: 'c', target: 'rate', kind: 'add', value: 9 },
    ]).rateMult).toBe(5);
    expect(resolveModifiers([{ id: 'd', target: 'demonRate', kind: 'mul', value: 9 }]).demonMult).toBe(3);
  });

  it('坏 modifier（target/kind 非法、value 非有限）不进乘数链', () => {
    const bad = resolveModifiers([
      { id: 'x', target: 'nowhere', kind: 'mul', value: 2 },
      { id: 'y', target: 'rate', kind: 'set', value: 2 },
      { id: 'z', target: 'rate', kind: 'mul', value: Number.NaN },
      { id: 'ok', target: 'rate', kind: 'mul', value: 1.5 },
    ] as never);
    expect(bad.rateMult).toBeCloseTo(1.5, 12);
    expect(bad.ignored).toEqual(['x', 'y', 'z']);
  });
});

// 契约 §2.4：同一次缓存命中同时决定「产出 ×hitGainMultiplier」和「该步计 hitStepCost」，
// 两件事必须来自同一个判断，不允许出现产出按命中打折、步数按未命中收的裂口径。
describe('玉简的产出与步数同源（契约 §2.4，任务 7A）', () => {
  it('命中才返回 stepCost，未命中不返回该字段（VM 缺省即 1）', () => {
    const jade = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: JADE });
    expect(jade.execute(req('breath', 1))).toEqual({ qi: 1, demonDelta: 0.00005 });
    const hit = jade.execute(req('breath', 2));
    expect(hit.stepCost).toBe(0);
    expect(hit.qi).toBeCloseTo(0.8 * 0.7, 12);
  });

  it('两个表值各自独立：×1 计 0 步 / ×0.7 计 1 步都能单独表达', () => {
    const onlySteps = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: { sameActionId: true, hitGainMultiplier: 1, hitStepCost: 0 } });
    onlySteps.execute(req('breath', 1));
    expect(onlySteps.execute(req('breath', 2)).qi).toBeCloseTo(0.8, 12);
    expect(onlySteps.observed.repeats).toBe(1);

    const onlyGain = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: { sameActionId: true, hitGainMultiplier: 0.7, hitStepCost: 1 } });
    onlyGain.execute(req('breath', 1));
    const costed = onlyGain.execute(req('breath', 2));
    expect(costed.qi).toBeCloseTo(0.8 * 0.7, 12);
    expect(costed.stepCost).toBe(1);
  });

  it('链序不动：baseGain × actionMult(k) × cacheHitMult × realmActionMult × bookDecay × rateMult', () => {
    const sink = makeActionSink({
      content: CONTENT,
      realmIndex: 1,
      jadeCache: JADE,
      bookDecay: 0.5,
      modifiers: [{ id: 'shuang', target: 'rate', kind: 'mul', value: 2 }],
    });
    sink.execute(req('breath', 1));
    const hit = sink.execute(req('breath', 2));
    // 按 §2.1 的书写顺序逐步相乘，结果必须逐位相同：换序就是另一条平衡口径（TS↔Python 严格相等）
    const expected = (((1 * actionMult(2)) * JADE.hitGainMultiplier) * 3) * 0.5 * 2;
    expect(hit.qi).toBe(expected);
    expect(hit.qi).toBeCloseTo(1.68, 12);
  });

  it('命中仍照常增长心魔（§2.2.1 按执行计，不因缓存减免）', () => {
    const plain = makeActionSink({ content: CONTENT, realmIndex: 0 });
    const jade = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: JADE });
    plain.execute(req('breath', 1, 1));
    jade.execute(req('breath', 1, 1));
    const miss = plain.execute(req('breath', 2, 1));
    const hit = jade.execute(req('breath', 2, 1));

    expect(hit.demonDelta).toBe(miss.demonDelta);
    expect(hit.demonDelta).toBeCloseTo(0.000075, 12);
    expect(hit.qi).toBeCloseTo(miss.qi * 0.7, 12);
  });

  it('observed 交出四个计数：executed / repeats / distinct / stepCostTotal', () => {
    const jade = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: JADE });
    jade.execute(req('breath', 1));
    jade.execute(req('breath', 2));
    jade.execute(req('calm', 3));

    expect(jade.observed).toEqual({ repeats: 1, executed: 3, distinct: 2, stepCostTotal: 2 });
    // k 回到 1 = 新 tick：distinct 跟着 seen 一起清零，repeats 是累计观察不清
    jade.execute(req('breath', 1));
    expect(jade.observed.distinct).toBe(1);
    expect(jade.observed.repeats).toBe(1);
    expect(jade.observed.executed).toBe(4);
  });

  it('卸下玉简与不装完全一致：产出不打折、stepCost 不出现（成对装卸）', () => {
    const worn = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: JADE });
    worn.execute(req('breath', 1));
    const hit = worn.execute(req('breath', 2));

    const off = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: null });
    off.execute(req('breath', 1));
    const same = off.execute(req('breath', 2));

    const unworn = makeActionSink({ content: CONTENT, realmIndex: 0 });
    unworn.execute(req('breath', 1));

    expect(hit.stepCost).toBe(0);
    // 显式传 null（卸下）与根本不传这个入参（不装）必须逐字段相同，否则「成对移除」只是名义上移除
    expect(same).toEqual(unworn.execute(req('breath', 2)));
    expect(same.qi).toBeCloseTo(0.8, 12);
  });

  it('budget 类 modifier 由道具侧消费，books 侧的 resolveModifiers 口径不变', () => {
    const mods: Modifier[] = [{ id: 'abacus_budget', target: 'budget', kind: 'add', value: 50 }];
    expect(resolveModifiers(mods).add.budget).toBe(50);
  });
});
