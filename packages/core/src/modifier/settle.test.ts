import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/loader';
import type { ActionRequest } from '../vm/interpreter';
import { actionMult, makeActionSink } from './settle';

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

    const jade = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: true });
    jade.execute(req('breath', 1));
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
