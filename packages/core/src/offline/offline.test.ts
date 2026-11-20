import { describe, expect, it } from 'vitest';
import type { JadeCacheSpec } from '../content/artifacts';
import { loadContent } from '../content/loader';
import type { Content, RealmDef } from '../content/schema';
import { noiseGainMult } from '../demon/rules';
import { makeActionSink } from '../modifier/settle';
import { passivePerTick } from '../realm/rules';
import { BASE_BUDGET, TICK_MS } from '../types';
import type { Op } from '../vm/program';
import { Vm } from '../vm/interpreter';
import { AWAY_FRAME_BUDGET_MS, MAX_CATCHUP_TICKS, Scheduler } from '../vm/scheduler';
import { demonlessSink, offlineElapsedMs, offlineTicks, OFFLINE_CAP_MS, OFFLINE_MIN_MS, OFFLINE_RATE, planAwayResume, settleOffline, settleOfflineIfAway, type OfflineWorld } from './offline';

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
  /** 宿主入口：§7.2 的 60 秒下限在这里判，不够就 null 且不碰 vm。 */
  readonly settleAway: (lastSeenAt: number, allowBreakthrough: boolean) => ReturnType<typeof settleOfflineIfAway>;
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

  // 两个入口共用同一份入参：下限那条只该差在「有没有进 settleOffline」，别在夹具里再抄一套口径。
  const input = (lastSeenAt: number, allowBreakthrough: boolean) => ({
    vm,
    realms: REALMS,
    world,
    now: NOW,
    lastSeenAt,
    allowBreakthrough,
    chargeWindowMs: () => options.windowMs ?? 0,
    onBreakthrough: (realmIndex: number) => {
      sink = makeActionSink({ content: CONTENT, realmIndex });
    },
  });

  return {
    world,
    settle: (lastSeenAt, allowBreakthrough) => settleOffline(input(lastSeenAt, allowBreakthrough)),
    settleAway: (lastSeenAt, allowBreakthrough) => settleOfflineIfAway(input(lastSeenAt, allowBreakthrough)),
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
    // 达标那一 tick 的 1 点算进 rawGained，之后 299 个 tick 每 tick = 动作 1×3 + 筑基被动 0.5
    expect(result.rawGained).toBeCloseTo(1 + 299 * 3.5, 9);
    // 归零掉的存量不退回：入账 = 每 tick 0.6 折的累加，finalQi 才是宿主写回存档的数
    expect(result.creditedGained).toBeCloseTo((1 + 299 * 3.5) * OFFLINE_RATE, 6);
    expect(result.finalQi).toBeCloseTo(299 * 3.5 * OFFLINE_RATE, 6);
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
    const result = settle(NOW - 60 * MINUTE, true);

    // 60 分钟封顶 → 36 000 tick：1 667 tick 后达标冲关，剩下的按筑基每 tick 2.1 冲到 2e4 之上
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

// ——————————————————————————————————————————————————————————————
// C7：离线与在线是**同一条乘数链**，只差 0.6 折算
// ——————————————————————————————————————————————————————————————

// 在线参照：照 runtime.run() 那行式子记账（`result.gain × noiseGainMult + passivePerTick`），
// 用真 Scheduler 按「单帧 5 tick」推满 60 分钟 —— 7 200 帧 × 5 = 36 000 tick，
// 正好是离线那一头的 tick 数。心魔钉在 0（程序只有吐纳），杂念乘数恒 1，
// 于是两边每 tick 的产出必须逐位相同；一旦离线漏掉被动、或把乘数链换了序，这里立刻散架。
function onlineLedger(input: { readonly realmIndex: number; readonly code: readonly Op[] }): {
  readonly raw: number; readonly folded: number; readonly ticks: number;
} {
  const realm = REALMS[input.realmIndex]!;
  let qi = 0;
  let demon = 0;
  let raw = 0;
  let folded = 0;
  let ticks = 0;
  // 在线也用 demonlessSink：C7 要比的是「同一份乘数链」，心魔增长是宿主策略不是乘数链本身
  const baseSink = makeActionSink({ content: CONTENT, realmIndex: input.realmIndex });
  const vm = new Vm({
    content: CONTENT,
    sink: demonlessSink(() => baseSink),
    vars: () => ({ qi, rate: 0, demon, realm: realm.id, budget: BASE_BUDGET }),
  });
  vm.installUnchecked([{ id: 'p0', code: input.code }]);
  const scheduler = new Scheduler({ vm });
  const frameMs = MAX_CATCHUP_TICKS * TICK_MS;

  for (let frame = 0; frame < OFFLINE_CAP_MS / frameMs; frame += 1) {
    for (const result of scheduler.advance(frameMs)) {
      const gained = result.gain * noiseGainMult({ demon, seed: SEED_WIN, tick: result.tick }) + passivePerTick(realm);
      qi += gained;
      raw += gained;
      folded += gained * OFFLINE_RATE;
      ticks += 1;
      demon = Math.min(1, Math.max(0, demon + result.demonDelta));
    }
  }
  expect(scheduler.pendingMs).toBe(0);
  return { raw, folded, ticks };
}

function offlineLedger(input: { readonly realmIndex: number; readonly code: readonly Op[] }): ReturnType<typeof settleOffline> {
  const world: OfflineWorld = { qi: 0, demon: 0, realmIndex: input.realmIndex, chargeReadyAt: 0, attempt: 1, seed: SEED_WIN };
  // sink 建一次就交给 getter：settleOffline 换境界时靠它取新乘数，这里同样不能每个 ACTION 重建一份
  let sink = makeActionSink({ content: CONTENT, realmIndex: input.realmIndex });
  const vm = new Vm({
    content: CONTENT,
    sink: demonlessSink(() => sink),
    vars: () => ({ qi: world.qi, rate: 0, demon: world.demon, realm: REALMS[world.realmIndex]!.id, budget: BASE_BUDGET }),
  });
  vm.installUnchecked([{ id: 'p0', code: input.code }]);
  return settleOffline({
    vm, realms: REALMS, world, now: NOW, lastSeenAt: NOW - OFFLINE_CAP_MS,
    allowBreakthrough: false, chargeWindowMs: () => 0,
    onBreakthrough: (realmIndex) => { sink = makeActionSink({ content: CONTENT, realmIndex }); },
  });
}

describe('离线↔在线同一条乘数链（C7）', () => {
  const BREATH_ONLY: readonly Op[] = [{ op: 'ACTION', actionId: 'breath' }, { op: 'HALT' }];
  const LOOP_TEN: readonly Op[] = [{ op: 'LOOP_BEGIN', end: 2, count: 10 }, { op: 'ACTION', actionId: 'breath' }, { op: 'LOOP_END', begin: 0 }, { op: 'HALT' }];

  it.each([
    { name: '炼气（动作 1、被动 0）', realmIndex: 0, perTick: 1 },
    { name: '筑基（动作 1×3、被动 0.5）', realmIndex: 1, perTick: 3.5 },
    { name: '元婴（动作 1×100、被动 15）', realmIndex: 3, perTick: 115 },
  ])('$name：60 分钟的未折产出与在线逐位相等，入账是它的 0.6 倍', ({ realmIndex, perTick }) => {
    const online = onlineLedger({ realmIndex, code: BREATH_ONLY });
    const offline = offlineLedger({ realmIndex, code: BREATH_ONLY });

    expect(online.ticks).toBe(36_000);
    expect(offline.ticks).toBe(online.ticks);
    expect(offline.ran).toBe(online.ticks);
    // 严格相等，不是 closeTo：两边都是「每 tick 同一个数累加 36 000 次」，加法和顺序都不许变
    expect(offline.rawGained).toBe(online.raw);
    expect(offline.creditedGained).toBe(online.folded);
    expect(offline.finalQi).toBe(online.folded);
    expect(online.raw).toBe(36_000 * perTick);
  });

  it('循环体不改变结论：同一份程序在两边算出同一个 raw', () => {
    const online = onlineLedger({ realmIndex: 1, code: LOOP_TEN });
    const offline = offlineLedger({ realmIndex: 1, code: LOOP_TEN });

    //  parity check: both paths use the same乘数链, so raw must match exactly
    expect(offline.rawGained).toBe(online.raw);
    expect(offline.creditedGained).toBe(online.folded);
    //  absolute value: 筑基 LOOP_TEN with budget truncation → ~16.66/tick
    expect(online.raw).toBeGreaterThan(500_000);
    expect(online.raw).toBeLessThan(700_000);
  });

  it('折算是逐 tick 落进存量的，不是最后一次性乘 0.6', () => {
    const online = onlineLedger({ realmIndex: 0, code: BREATH_ONLY });
    const offline = offlineLedger({ realmIndex: 0, code: BREATH_ONLY });

    // 0.6 在二进制里不精确：逐 tick 累加 36 000 次与「先累加再一次乘」是两个不同的数。
    // 离线要的是前者（阈值判定跟着折后存量走），所以这里既钉住「等于逐 tick 那份」，也钉住「不等于一次性乘那发」。
    expect(offline.creditedGained).toBe(online.folded);
    expect(offline.creditedGained).toBeCloseTo(online.raw * OFFLINE_RATE, 6);
    expect(online.folded).not.toBe(online.raw * OFFLINE_RATE);
  });
});

// ——————————————————————————————————————————————————————————————
// 契约 §7.2「下限 60 秒」：不到一分钟的离开连快进都不许跑
// ——————————————————————————————————————————————————————————————
describe('离线下限 60 秒（契约 §7.2）', () => {
  it('59 999ms → null，且一帧都没算：存量不许被刷新白拿', () => {
    // 挑一个「跑起来就一定有产出、还会冲关」的档：qi 差 0.5 达标 + 炼气每 tick 0.6
    // 只要 settlement 真跑了，world.qi 就会涨过 1e3 并写出 breakthroughs，一眼能看出漏判。
    const { world, settleAway } = harness({ qi: 999.5, demon: 0.42, seed: SEED_WIN });

    expect(settleAway(NOW - (OFFLINE_MIN_MS - 1), true)).toBeNull();
    expect(world.qi).toBe(999.5);
    expect(world.realmIndex).toBe(0);
    expect(world.chargeReadyAt).toBe(0);

    // 对照：同一份夹具走 settleOffline（没有下限）照样产出，证明 null 来自下限而不是零产出
    const control = harness({ qi: 999.5, demon: 0.42, seed: SEED_WIN });
    expect(control.settle(NOW - (OFFLINE_MIN_MS - 1), true).ran).toBe(599);
  });

  it('60 000ms 正好到线 → 正常结算 600 tick', () => {
    const { world, settleAway } = harness({ qi: 999.5, seed: SEED_WIN });
    const result = settleAway(NOW - OFFLINE_MIN_MS, false);

    expect(result).not.toBeNull();
    expect(result?.elapsedMs).toBe(OFFLINE_MIN_MS);
    expect(result?.ticks).toBe(600);
    expect(result?.ran).toBe(600);
    expect(world.qi).toBeCloseTo(999.5 + 600 * 0.6, 6);
    expect(result?.stoppedReason).toBe('cap');
  });

  it('整分钟以上的离线照旧出报告（下限不是封顶）', () => {
    const result = harness().settleAway(NOW - 30 * MINUTE, false);

    expect(result?.ticks).toBe(18_000);
    expect(result?.creditedGained).toBeCloseTo(10_800, 6);
  });
});

describe('时钟回拨（lastSeenAt 在未来）', () => {
  it('lastSeenAt > now → elapsed=0、不出报告、成功次数 0', () => {
    const now = NOW;
    const futureLastSeenAt = now + 5 * MINUTE; // 5 分钟后
    const result = settleOffline({
      vm: new Vm({ content: CONTENT, sink: makeActionSink({ content: CONTENT, realmIndex: 0 }), vars: () => ({ qi: 0, rate: 0, demon: 0, realm: 0, budget: BASE_BUDGET }) }),
      realms: CONTENT.realms,
      world: { qi: 100, demon: 0.2, realmIndex: 0, chargeReadyAt: 0, attempt: 1, seed: SEED_WIN },
      now,
      lastSeenAt: futureLastSeenAt,
      allowBreakthrough: false,
      chargeWindowMs: () => 0,
    });
    expect(result.ran).toBe(0);
    expect(result.elapsedMs).toBe(0);
    expect(result.creditedGained).toBe(0);
    expect(result.rawGained).toBe(0);
    expect(result.breakthroughs).toEqual([]);
  });
});

// 契约 §1「后台恢复（R3）」：空窗 <60s 全额重放、≥60s 走离线公式，两种都不得静默丢弃。
// 分流是纯函数，所以这里只判「该补几个 tick / 该不该走离线」；重放本身走真 VM，由浏览器验收 (a)(b)(c) 取证。
describe('planAwayResume（契约 §1 R3）', () => {
  it('分块单位就是一帧的补帧预算：5 tick = 500ms', () => {
    expect(AWAY_FRAME_BUDGET_MS).toBe(MAX_CATCHUP_TICKS * TICK_MS);
    expect(AWAY_FRAME_BUDGET_MS).toBe(500);
  });

  it('切走 3 秒 → 补 30 tick（不是过去那种只补 5 然后抹掉）', () => {
    expect(planAwayResume({ gapMs: 3_000 })).toEqual({ kind: 'replay', ticks: 30, penaltyMs: 0 });
  });

  it('切走 70 秒 → 走离线结算，且带真实空窗时长给报告', () => {
    expect(planAwayResume({ gapMs: 70_000 })).toEqual({ kind: 'offline', elapsedMs: 70_000 });
  });

  it('边界：500ms 补 5 tick；59_999ms 仍重放；60_000ms 起走离线（§7.2 下限不动）', () => {
    expect(planAwayResume({ gapMs: 500 })).toEqual({ kind: 'replay', ticks: 5, penaltyMs: 0 });
    expect(planAwayResume({ gapMs: 59_999 })).toEqual({ kind: 'replay', ticks: 599, penaltyMs: 0 });
    expect(planAwayResume({ gapMs: 60_000 })).toEqual({ kind: 'offline', elapsedMs: 60_000 });
  });

  it('不足一个 tick 的零头不补（与 offlineTicks 同口径）', () => {
    expect(planAwayResume({ gapMs: 1_099 }).kind).toBe('replay');
    expect((planAwayResume({ gapMs: 1_099 }) as { ticks: number }).ticks).toBe(10);
  });

  it('走火惩罚期内切走 3 秒：先扣掉 2 秒惩罚，只付剩下的 10 tick', () => {
    expect(planAwayResume({ gapMs: 3_000, penaltyMs: 2_000 })).toEqual({ kind: 'replay', ticks: 10, penaltyMs: 2_000 });
  });

  it('惩罚比空窗长 → 一个 tick 都不付，penaltyMs 只按实际扣到的部分报', () => {
    expect(planAwayResume({ gapMs: 1_000, penaltyMs: 5_000 })).toEqual({ kind: 'replay', ticks: 0, penaltyMs: 1_000 });
  });

  it('倍速只放大重放（契约 §7.3「倍速只影响在线」）：3 秒 ×3 → 90 tick', () => {
    expect(planAwayResume({ gapMs: 3_000, speed: 3 })).toEqual({ kind: 'replay', ticks: 90, penaltyMs: 0 });
  });

  it('≥60 秒那支不吃倍速：判定与时长都用真实墙钟', () => {
    expect(planAwayResume({ gapMs: 70_000, speed: 3 })).toEqual({ kind: 'offline', elapsedMs: 70_000 });
  });

  it('脏输入（负数 / NaN）退化成「没空窗」，不会倒扣存量', () => {
    expect(planAwayResume({ gapMs: -5_000 })).toEqual({ kind: 'replay', ticks: 0, penaltyMs: 0 });
    expect(planAwayResume({ gapMs: Number.NaN })).toEqual({ kind: 'replay', ticks: 0, penaltyMs: 0 });
  });
});
