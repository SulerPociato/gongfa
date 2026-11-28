import { beforeAll, describe, expect, it } from 'vitest';
import type { Program } from '@gongfa/core';
import { AUTO_RATE } from '@gongfa/core';
import { createRuntime } from './runtime';

// runtime 读 ?seed= / ?demo= / ?realm= 这些查询串，node 环境里没有 window，构造时先补一个空 location。
beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = { location: { search: '' } };
});

const PROGRAM: Program = {
  id: 'gongfa',
  code: [{ op: 'ACTION', actionId: 'breath' }, { op: 'HALT' }],
};

function running(): ReturnType<typeof createRuntime> {
  const runtime = createRuntime();
  expect(runtime.load(PROGRAM)).toEqual([]);
  return runtime;
}

describe('runtime.run 的 dt 入口（真机停摆的回归）', () => {
  // 先证明「时间在走」，否则下面那句「qi 不变」是空话：rate=0 的 runtime 喂什么 dt 都不会变数。
  it('正控制：1000ms 补满 10 个 tick，qi / rate / ticks 全部在动', () => {
    const runtime = running();
    runtime.run(1000);
    const s = runtime.state();
    expect(s.rate).toBeGreaterThan(0);
    expect(s.ticks).toBe(10);
    expect(s.qi).toBeGreaterThan(0);
  });

  it('restore 后灵根由存档 seed 决定，不再沿用构造时的随机种子', () => {
    const runtime = createRuntime({ seed: 0 });
    expect(runtime.state().lingGen).toBe('天灵根');
    runtime.restore({
      schemaVersion: 1,
      seed: 5,
      realm: 1,
      qi: '0',
      demon: 0,
      workspace: { blocks: { languageVersion: 0, blocks: [] } },
      programs: [],
      budgetPool: 200,
      computeLimit: null,
      ownedBooks: [],
      equippedBook: null,
      ownedArtifacts: [],
      equippedArtifacts: [],
      offlineRate: 0.6,
      stats: { totalQi: '0', breakthroughs: 0, playMs: 0 },
      lastSeenAt: 0,
      speed: 1,
      chargeReadyAt: 0,
    });
    expect(runtime.state().lingGen).toBe('下品灵根');
  });

  it('run(-1) 不抛，qi / ticks / playMs 一律不动', () => {
    const runtime = running();
    runtime.run(1000);
    const before = runtime.state();
    expect(() => runtime.run(-1)).not.toThrow();
    const after = runtime.state();
    expect(after.qi).toBe(before.qi);
    expect(after.ticks).toBe(before.ticks);
    expect(after.playMs).toBe(before.playMs);
  });

  it('真机那一下 -9.999999523162842 也不抛', () => {
    const runtime = running();
    expect(() => runtime.run(-9.999999523162842)).not.toThrow();
    expect(runtime.state().ticks).toBe(0);
  });

  it('NaN 与 ±Infinity 当 0：非有限的时钟读数不是空窗，不推进也不抛', () => {
    const runtime = running();
    runtime.run(1000);
    const before = runtime.state();
    for (const dt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => runtime.run(dt)).not.toThrow();
    }
    const after = runtime.state();
    expect(after.ticks).toBe(before.ticks);
    expect(after.qi).toBe(before.qi);
  });

  it('run(0) 是合法空帧：不抛、不推进，accumulator 留着跨帧', () => {
    const runtime = running();
    expect(() => runtime.run(0)).not.toThrow();
    expect(runtime.state().ticks).toBe(0);
    runtime.run(60);
    expect(runtime.state().ticks).toBe(0);
    runtime.run(60);
    expect(runtime.state().ticks).toBe(1);
  });
});

// 批次 1 的两个新入口：托管档点击与「结算前的境界名」。
// ?debug=1&charge=0 把蓄势窗口设成 0（runtime 自带的 debug 口径），剩下的门槛只有存量。
function challengeable(seed: number): ReturnType<typeof createRuntime> {
  (globalThis as unknown as { window: { location: { search: string } } }).window =
    { location: { search: '?debug=1&charge=0' } };
  const runtime = createRuntime({ seed });
  expect(runtime.load(PROGRAM)).toEqual([]);
  // 炼气阈值 1e3，一块吐纳 10/秒 → 跑到过线；demon 只涨到 0.05 左右，不会踩进走火惩罚期。
  while (runtime.state().qi < 1000) runtime.run(1000);
  expect(runtime.state().canChallenge).toBe(true);
  return runtime;
}

describe('pressChallenge 的档位与结算前的境界名', () => {
  // seed 11 的第 1 次骰 = 0.0676：85% 与 60% 两档都成；seed 7 = 0.9847：两档都败。
  it('挑战中点「交给天意」= 按 AUTO_RATE 结算，mode 落 auto', () => {
    const runtime = challengeable(11);
    expect(runtime.pressChallenge().phase).toBe('trial');
    const result = runtime.pressChallenge('auto');
    expect(result.phase).toBe('settled');
    expect(result.mode).toBe('auto');
    expect(result.rate).toBe(AUTO_RATE);
    expect(result.ok).toBe(true);
    expect(runtime.state().lastChallenge).toBe(result);
  });

  it('挑战中再点主按钮 = 承雷，不是当场结算', () => {
    // 批次 38：渡劫中再点主按钮 = 承雷，不再当场结算（结算要等三波雷走完或点「交给天意」）。
    const runtime = challengeable(11);
    runtime.pressChallenge();
    const result = runtime.pressChallenge();
    expect(result.phase).toBe('trial');
    expect(result.mode).toBe('parry');
    expect(runtime.state().trialParry?.hits).toBe(0); // 刚进渡劫就点，不在雷点窗口内 = 拍空
  });

  it('渡劫中点「交给天意」= 立即按 AUTO_RATE 结算', () => {
    const runtime = challengeable(11);
    runtime.pressChallenge();
    const result = runtime.pressChallenge('auto');
    expect(result.mode).toBe('auto');
    expect(result.rate).toBe(AUTO_RATE);
    expect(runtime.state().trialParry).toBeNull();
  });

  // 开启那一次点击只负责把 10 秒窗口打开（mode 在这一帧没有意义），档位由窗口里的第二次点击定。
  it('fromRealmName 是结算前的境：成功时与 realmName 差一境', () => {
    const runtime = challengeable(11);
    runtime.pressChallenge();
    const result = runtime.pressChallenge('auto');
    expect(result.fromRealmName).toBe('炼气');
    expect(result.realmName).toBe('筑基');
  });

  it('失败时两个名字相同，境界没动', () => {
    const runtime = challengeable(7);
    runtime.pressChallenge();
    const result = runtime.pressChallenge('auto');
    expect(result.ok).toBe(false);
    expect(result.fromRealmName).toBe('炼气');
    expect(result.realmName).toBe('炼气');
  });
});

describe('保底：跨刷新恢复与连败必成（2026-11-26）', () => {
  it('restoreAttempt 只接受 1..3：0/负数回 1，≥3 当 3，非整数忽略', () => {
    const runtime = challengeable(11);
    runtime.restoreAttempt(2);
    expect(runtime.state().attempt).toBe(2);
    runtime.restoreAttempt(99);
    expect(runtime.state().attempt).toBe(3);
    runtime.restoreAttempt(0);
    expect(runtime.state().attempt).toBe(1);
    runtime.restoreAttempt(Number.NaN);
    expect(runtime.state().attempt).toBe(1);
  });

  it('同一境界连败两次后，第 3 次必成（seed 73 前两发骰都烂也一样）', () => {
    let now = 1_000_000;
    (globalThis as unknown as { window: { location: { search: string } } }).window =
      { location: { search: '?debug=1&charge=0' } };
    const runtime = createRuntime({ seed: 73 }, { now: () => now });
    expect(runtime.load(PROGRAM)).toEqual([]);
    const topUp = (): void => { while (runtime.state().qi < 1000) runtime.run(1000); };

    topUp();
    runtime.pressChallenge();
    const first = runtime.pressChallenge('auto');
    expect(first.ok).toBe(false);
    expect(runtime.state().attempt).toBe(2);

    now += 60_001;
    topUp();
    runtime.pressChallenge();
    const second = runtime.pressChallenge('auto');
    expect(second.ok).toBe(false);
    expect(runtime.state().attempt).toBe(3);

    now += 60_001;
    topUp();
    // 第 3 次即便骰值仍然很烂也必须成：forced 来自 attempt >= GUARANTEE_ATTEMPT。
    runtime.pressChallenge();
    const third = runtime.pressChallenge('auto');
    expect(third.ok).toBe(true);
    expect(third.forced).toBe(true);
    expect(runtime.state().realmName).toBe('筑基');
    expect(runtime.state().attempt).toBe(1);
  });
});
