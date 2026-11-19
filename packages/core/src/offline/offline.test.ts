import { describe, expect, it } from 'vitest';
import type { JadeCacheSpec } from '../content/artifacts';
import { loadContent } from '../content/loader';
import type { Content, RealmDef } from '../content/schema';
import { makeActionSink } from '../modifier/settle';
import { BASE_BUDGET, TICK_MS } from '../types';
import type { Op } from '../vm/program';
import { Vm } from '../vm/interpreter';
import { demonlessSink, offlineElapsedMs, offlineTicks, OFFLINE_CAP_MS, OFFLINE_RATE, settleOffline, type OfflineWorld } from './offline';

// 境界四件套照契约 §2.3 / §3 的目标表：阈值、被动、动作乘数一个都不改，
// 这样「1 小时闭关 = 36 000 tick」这类数字可以拿契约表反查。
// REALMS 取解析后的那一行，测试断言与 sink 用的乘数就只剩一份来源。
const CONTENT: Content = loadContent({
  actions: [
    { id: 'breath', baseGain: 1, demonDelta: 0, kind: 'gain' },
    { id: 'calm', baseGain: 0, demonDelta: -0.0005, kind: 'calm' },
  ],
  realms: [
    { id: 0, name: { zh: '炼气' }, threshold: '1e3', passivePerSec: 0, actionMult: 1 },
    { id: 1, name: { zh: '筑基' }, threshold: '2e4', passivePerSec: 5, actionMult: 3 },
    { id: 2, name: { zh: '金丹' }, threshold: '4e5', passivePerSec: 30, actionMult: 25 },
    { id: 3, name: { zh: '元婴' }, threshold: '2.5e6', passivePerSec: 150, actionMult: 100 },
  ],
});

const REALMS: readonly RealmDef[] = CONTENT.realms;

const ONE_BREATH: readonly Op[] = [{ op: 'ACTION', actionId: 'breath' }, { op: 'HALT' }];
const EMPTY: readonly Op[] = [{ op: 'HALT' }];

// 渡劫随机（§7.1）用的三个种子，roll 是实测值（mulberry32 稳定，改实现要重算）：
// seed 1 第 1 次 0.074014 < 0.60 → 成；seed 2 第 1 次 0.730961 → 败；seed 4 第 3 次 0.989381 → 本会败，被保底救。
const SEED_WIN = 1;
const SEED_LOSE = 2;
const SEED_GUARANTEE = 4;

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

interface HarnessOptions {
  readonly code?: readonly Op[];
  readonly realmIndex?: number;
  readonly qi?: number;
  readonly demon?: number;
  readonly seed?: number;
  readonly attempt?: number;
  readonly chargeReadyAt?: number;
  readonly windowMs?: number;
  /** 默认关掉心魔（宿主就是这么接的）；开成 false 用来证明 settleOffline 自己不碰心魔轴。 */
  readonly muteDemon?: boolean;
}

interface Harness {
  readonly world: OfflineWorld;
  readonly settle: (lastSeenAt: number, allowBreakthrough: boolean) => ReturnType<typeof settleOffline>;
}

function harness(options: HarnessOptions = {}): Harness {
  const world: OfflineWorld = {
    qi: options.qi ?? 0,
    demon: options.demon ?? 0,
    realmIndex: options.realmIndex ?? 0,
    chargeReadyAt: options.chargeReadyAt ?? 0,
    attempt: options.attempt ?? 1,
    seed: options.seed ?? SEED_WIN,
  };
  // 和 runtime 同一条转发：VM 拿到的是「当下这次读 sink」的闭包，渡劫换境界后不会留着旧乘数。
  let sink = makeActionSink({ content: CONTENT, realmIndex: world.realmIndex });
  const live = { execute: (request: Parameters<typeof sink.execute>[0]) => sink.execute(request) };
  const muted = demonlessSink(() => sink);
  const vm = new Vm({
    content: CONTENT,
    sink: (options.muteDemon ?? true) ? muted : live,
    vars: () => ({ qi: world.qi, rate: 0, demon: world.demon, realm: REALMS[world.realmIndex]?.id ?? 0, budget: BASE_BUDGET }),
  });
  vm.installUnchecked([{ id: 'p0', code: options.code ?? ONE_BREATH }]);

  return {
    world,
    settle: (lastSeenAt, allowBreakthrough) => settleOffline({
      vm,
      realms: REALMS,
      world,
      now: NOW,
      lastSeenAt,
      allowBreakthrough,
      chargeWindowMs: () => options.windowMs ?? 0,
      onBreakthrough: (realmIndex) => {
        sink = makeActionSink({ content: CONTENT, realmIndex });
      },
    }),
  };
}

describe('离线窗口算术（契约 §7.2）', () => {
  it('elapsed 夹在 0..60min：回拨给 0，3 小时给 60 分钟', () => {
    expect(offlineElapsedMs(NOW, NOW - 30_000)).toBe(30_000);
    expect(offlineElapsedMs(NOW, NOW)).toBe(0);
    expect(offlineElapsedMs(NOW, NOW + 5_000)).toBe(0);
    expect(offlineElapsedMs(NOW, NOW - 3 * 60 * MINUTE)).toBe(OFFLINE_CAP_MS);
    expect(offlineElapsedMs(NOW, NOW - OFFLINE_CAP_MS)).toBe(OFFLINE_CAP_MS);
  });

  it('坏时间戳（NaN / Infinity）按「没有离线」处理，不抛异常', () => {
    expect(offlineElapsedMs(Number.NaN, NOW)).toBe(0);
    expect(offlineElapsedMs(NOW, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('ticks 向下取整：5 599ms 是 55 tick，满 60 分钟是 36 000 tick', () => {
    expect(offlineTicks(5_599)).toBe(55);
    expect(offlineTicks(99)).toBe(0);
    expect(offlineTicks(OFFLINE_CAP_MS)).toBe(36_000);
    expect(OFFLINE_CAP_MS / TICK_MS).toBe(36_000);
  });
});

describe('demonlessSink（契约 §7.2「demonDelta 一律归零」）', () => {
  it('吐纳的增长与调息的负增量都归零，qi 与步数原样透传', () => {
    const source = {
      execute: () => ({ qi: 2.5, demonDelta: 0.00005, stepCost: 0 }),
    };
    const wrapped = demonlessSink(() => source);
    const outcome = wrapped.execute({ actionId: 'breath', k: 1, pc: 0, loopDepth: 0 });
    expect(outcome.demonDelta).toBe(0);
    expect(outcome.qi).toBe(2.5);
    expect(outcome.stepCost).toBe(0);
  });

  it('转发走 getter：换掉 sink 后立刻吃到新境界的乘数（渡劫不能带着旧 actionMult 跑）', () => {
    let current = { execute: () => ({ qi: 1, demonDelta: 0 }) };
    const wrapped = demonlessSink(() => current);
    expect(wrapped.execute({ actionId: 'breath', k: 1, pc: 0, loopDepth: 0 }).qi).toBe(1);
    current = { execute: () => ({ qi: 3, demonDelta: 0.5 }) };
    expect(wrapped.execute({ actionId: 'breath', k: 1, pc: 0, loopDepth: 0 }).qi).toBe(3);
  });

  it('真实 sink 的调息 −0.0005 与玉简命中的心魔增长都被抹平，qi 与命中步数不丢', () => {
    const spec: JadeCacheSpec = { sameActionId: true, hitGainMultiplier: 0.7, hitStepCost: 0 };
    const bare = makeActionSink({ content: CONTENT, realmIndex: 0, jadeCache: spec });
    const wrapped = demonlessSink(() => bare);
    // 契约 §2.4 明写「命中仍照常增长心魔」，所以第二次执行裸 sink 一定拿得到正增量
    expect(bare.execute({ actionId: 'breath', k: 1, pc: 0, loopDepth: 0 }).demonDelta).toBeGreaterThan(0);
    expect(bare.execute({ actionId: 'breath', k: 2, pc: 1, loopDepth: 0 }).demonDelta).toBeGreaterThan(0);

    const hit = wrapped.execute({ actionId: 'breath', k: 2, pc: 1, loopDepth: 0 });
    expect(hit.demonDelta).toBe(0);
    // 1 × actionMult(2)=0.8 × 命中 0.7 × 炼气 1 = 0.56
    expect(hit.qi).toBeCloseTo(0.56, 12);
    expect(hit.stepCost).toBe(0);
    expect(wrapped.execute({ actionId: 'calm', k: 3, pc: 2, loopDepth: 0 }).demonDelta).toBe(0);
  });
});

describe('settleOffline 基础账（开关关 = 默认）', () => {
  it('30 分钟闭关：rawGained 按全额、入账按 0.6 折，境界被动也在这条轴上', () => {
    const { world, settle } = harness({ demon: 0.42 });
    const result = settle(NOW - 30 * MINUTE, false);

    // 30min = 18 000 tick，每 tick 1 点（炼气 actionMult 1）
    expect(result.ticks).toBe(18_000);
    expect(result.ran).toBe(18_000);
    expect(result.rawGained).toBeCloseTo(18_000, 9);
    expect(result.creditedGained).toBeCloseTo(10_800, 6);
    expect(world.qi).toBeCloseTo(10_800, 6);
    expect(result.finalQi).toBe(world.qi);
    expect(result.breakthroughs).toEqual([]);
    expect(result.stoppedReason).toBe('cap');
    expect(OFFLINE_RATE).toBe(0.6);
  });

  it('心魔轴整个离线期间不动：既不被增长项推高，也不被调息拉低（G1）', () => {
    // 故意不套 demonlessSink：证明「不写心魔」是 settleOffline 自己的口径，不依赖宿主的包装
    const grow = harness({ demon: 0.42, muteDemon: false });
    expect(grow.settle(NOW - 30 * MINUTE, false).creditedGained).toBeGreaterThan(0);
    expect(grow.world.demon).toBe(0.42);

    const calm = harness({ demon: 0.42, muteDemon: false, code: [{ op: 'ACTION', actionId: 'calm' }, { op: 'HALT' }] });
    calm.settle(NOW - 30 * MINUTE, false);
    expect(calm.world.demon).toBe(0.42);
  });

  it('60 分钟封顶等值：3 小时与整 60 分钟的账逐位相同（只算前 60 分钟，不是不给）', () => {
    const long = harness().settle(NOW - 3 * 60 * MINUTE, false);
    const exact = harness().settle(NOW - OFFLINE_CAP_MS, false);

    expect(long.ticks).toBe(36_000);
    expect(long).toEqual(exact);
  });

  it('跨过阈值继续累积，不封顶（阈值是门票，不是存量上限）', () => {
    const { world, settle } = harness();
    const result = settle(NOW - 60 * MINUTE, false);

    // 炼气 1/tick → 36 000 raw → 入账 21 600，早就越过 1e3 的阈值
    expect(result.finalQi).toBeGreaterThan(REALMS[0]!.threshold);
    expect(result.creditedGained).toBeCloseTo(21_600, 6);
    expect(world.realmIndex).toBe(0);
    expect(result.breakthroughs).toEqual([]);
  });

  it('被单独算：空工作区在筑基也有被动（Q1，在线 5/s ⇄ 离线 5/s×0.6）', () => {
    const { settle } = harness({ realmIndex: 1, code: EMPTY });
    const result = settle(NOW - 30 * MINUTE, false);

    // 18 000 tick × 0.5/tick（筑基被动 5/秒 ÷ 10）＝ 9 000 raw；凹槽空着，动作产出 0
    expect(result.rawGained).toBeCloseTo(18_000 * 0.5, 9);
    expect(result.creditedGained).toBeCloseTo(18_000 * 0.5 * OFFLINE_RATE, 6);
    expect(result.finalQi).toBe(result.creditedGained);
  });

  it('动作产出与被动同轴：筑基每 tick = 1×3 + 0.5', () => {
    const { settle } = harness({ realmIndex: 1 });
    const result = settle(NOW - 3_000, false);

    expect(result.ticks).toBe(30);
    expect(result.rawGained).toBeCloseTo(30 * 3.5, 9);
    expect(result.creditedGained).toBeCloseTo(30 * 3.5 * OFFLINE_RATE, 9);
  });

  it('不足一个 tick 的离线：全零、不报错、境界与存量原样带出', () => {
    const { world, settle } = harness({ qi: 123.5, demon: 0.3 });
    const result = settle(NOW - (TICK_MS - 1), false);

    expect(result.ticks).toBe(0);
    expect(result.ran).toBe(0);
    expect(result.rawGained).toBe(0);
    expect(result.creditedGained).toBe(0);
    expect(result.finalQi).toBe(123.5);
    expect(world.qi).toBe(123.5);
    expect(world.demon).toBe(0.3);
  });

  it('同参数跑两次结果一致（架构 §七：只要求自洽，不要求与在线逐 tick 等价）', () => {
    const a = harness({ seed: SEED_WIN }).settle(NOW - 60 * MINUTE, true);
    const b = harness({ seed: SEED_WIN }).settle(NOW - 60 * MINUTE, true);
    expect(a).toEqual(b);
  });

  it('截断的 tick 单独计数，不进 HUD 的红字（宿主看 stalledTicks 解释低产出）', () => {
    const code: Op[] = [...Array.from({ length: 210 }, () => ({ op: 'ACTION', actionId: 'breath' } as Op)), { op: 'HALT' }];
    const result = harness({ code }).settle(NOW - 3_000, false);

    expect(result.ticks).toBe(30);
    expect(result.stalledTicks).toBe(30);
  });
});

describe('离线渡劫（契约 §7.1 离线行 + §7.2）', () => {
  it('开关开 + 骰中：成功即境界 +1、qi 归 0、心魔涤清，剩余 tick 按新境界继续', () => {
    const { world, settle } = harness({ qi: 999.5, demon: 0.42, seed: SEED_WIN });
    const result = settle(NOW - 30_000, true);

    // 第 1 个 tick 就 +0.6 → 1 000.1 达标；炼气→筑基蓄势窗口 0 → 立刻尝试；roll 0.074014 < 0.60
    expect(result.breakthroughs).toEqual([{ realm: 1, ok: true }]);
    expect(world.realmIndex).toBe(1);
    expect(world.chargeReadyAt).toBe(0);
    // 成功后本境界的尝试序号重新从 1 数（和在线 settle 一致）
    expect(world.attempt).toBe(1);
    // 破境涤心是 §7.1 的后果，不属于「离线不涨心魔」那条禁令
    expect(world.demon).toBe(0);
    // 达标那一 tick 的 1 点算进 rawGained，之后 299 个 tick 每 tick 3 点（筑基 actionMult）
    expect(result.rawGained).toBeCloseTo(1 + 299 * 3, 9);
    // 归零掉的存量不退回：入账 = 全额 0.6 折，finalQi 才是宿主写回的数
    expect(result.creditedGained).toBeCloseTo((1 + 299 * 3) * OFFLINE_RATE, 6);
    expect(result.finalQi).toBeCloseTo(299 * 3 * OFFLINE_RATE, 6);
    expect(result.stoppedReason).toBe('cap');
  });

  it('开关开 + 骰偏：停在阈值、剩余 tick 不再产出，且一惩罚都不吃（G3）', () => {
    const { world, settle } = harness({ qi: 999.5, demon: 0.42, seed: SEED_LOSE });
    const result = settle(NOW - 30_000, true);

    expect(result.breakthroughs).toEqual([{ realm: 1, ok: false }]);
    expect(result.stoppedReason).toBe('threshold');
    expect(result.ran).toBe(1);
    expect(result.ticks).toBe(300);
    // 存量钉在阈值：达标那一 tick 的超出部分作废，所以入账是 0.5 而不是 0.6
    expect(world.qi).toBe(1e3);
    expect(result.finalQi).toBe(1e3);
    expect(result.creditedGained).toBeCloseTo(0.5, 12);
    expect(result.rawGained).toBe(1);
    // 无惩罚：不 ×0.85、不清心魔、境界不动
    expect(world.demon).toBe(0.42);
    expect(world.realmIndex).toBe(0);
    // G2：复用同一 attempt 序列，失败照样 +1
    expect(world.attempt).toBe(2);
  });

  it('G2 保底：本轮是同一境界第 3 次，骰到 0.989 也必成', () => {
    const { world, settle } = harness({ qi: 999.5, seed: SEED_GUARANTEE, attempt: 3 });
    const result = settle(NOW - 30_000, true);

    expect(result.breakthroughs).toEqual([{ realm: 1, ok: true }]);
    expect(world.realmIndex).toBe(1);
  });

  it('每次离线最多 1 次：成功后再达标也不补第二发', () => {
    const { world, settle } = harness({ seed: SEED_WIN });
    const result = settle(NOW - 2_000_000, true);

    // 60 分钟封顶 → 36 000 tick：1 667 tick 后达标冲关，剩下的按筑基速率冲到 2e4 之上
    expect(result.ticks).toBe(36_000);
    expect(result.breakthroughs.length).toBe(1);
    expect(world.realmIndex).toBe(1);
    expect(result.finalQi).toBeGreaterThan(REALMS[1]!.threshold);
  });

  it('蓄势未完（§7.3 离线也在蓄势）：不尝试，但产出照旧跑满', () => {
    const { world, settle } = harness({ qi: 999.5, seed: SEED_WIN, windowMs: 15 * MINUTE });
    const result = settle(NOW - 30_000, true);

    expect(result.breakthroughs).toEqual([]);
    expect(result.stoppedReason).toBe('cap');
    expect(world.realmIndex).toBe(0);
    expect(result.finalQi).toBeCloseTo(999.5 + 300 * 0.6, 6);
    // 达标发生在第 1 个 tick（虚拟时刻），窗口 15 分钟 → 就绪点落在离线区间之后
    expect(world.chargeReadyAt).toBe(NOW - 30_000 + TICK_MS + 15 * MINUTE);
  });

  it('离线首次达标会把 chargeReadyAt 写出来（§7.3「需记录达标时刻」，宿主直接落盘）', () => {
    const { world, settle } = harness({ chargeReadyAt: 0, windowMs: 0 });
    const result = settle(NOW - 60 * MINUTE, false);

    // 第 1 667 个 tick 首次跨过 1e3（0.6/tick），窗口 0 → 就绪 = 起始 + 1667×100ms
    expect(result.breakthroughs).toEqual([]);
    expect(world.chargeReadyAt).toBe(NOW - 60 * MINUTE + 1_667 * TICK_MS);
  });

  it('末境元婴：没有下一劫可冲 → 不尝试也不停摆，产出照常跑满', () => {
    const { world, settle } = harness({ realmIndex: 3, seed: SEED_WIN });
    const result = settle(NOW - 60 * MINUTE, true);

    expect(result.breakthroughs).toEqual([]);
    expect(result.stoppedReason).toBe('cap');
    expect(world.realmIndex).toBe(3);
    // 元婴每 tick = 1×100 + 15 = 115 raw
    expect(result.rawGained).toBeCloseTo(36_000 * 115, 0);
    expect(result.finalQi).toBeCloseTo(36_000 * 115 * OFFLINE_RATE, 0);
  });
});
