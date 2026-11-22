import { describe, expect, it } from 'vitest';
import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import { loadContent } from '../content/loader';
import type { Content } from '../content/schema';
import { Qi } from '../number/bignum';
import { demonlessSink } from '../offline/offline';
import { makeActionSink } from '../modifier/settle';
import { passivePerTick } from '../realm/rules';
import { BASE_BUDGET, TICKS_PER_SEC } from '../types';
import type { Op } from '../vm/program';
import { Vm } from '../vm/interpreter';
import { PREVIEW_POINTS, PREVIEW_SECONDS, PREVIEW_TICKS, linearizeProgram, previewCurve } from './curve';

// 真表：曲线预览的价值就在于「说的数就是游戏会给的数」，夹具表只能证明函数自洽。
const CONTENT: Content = loadContent({ actions: actionsJson, realms: realmsJson });

const BREATH: Op = { op: 'ACTION', actionId: 'breath' };
const CALM: Op = { op: 'ACTION', actionId: 'calm' };
const HALT: Op = { op: 'HALT' };

// 编译产物里「如果」长这样（compiler.emitIf）：条件三连 + JMP_IF_FALSE 指 else 入口 + JMP 跳过 else。
// 这里手抄一份，core 不依赖 blocks，方向性由 packages/blocks/src/preview.test.ts 用真编译器再钉一次。
const IF_ELSE_REPEAT: readonly Op[] = [
  { op: 'LOAD', key: 'demon' },
  { op: 'PUSH', value: 0.5 },
  { op: 'CMP', arg: '>' },
  { op: 'JMP_IF_FALSE', target: 6 },
  CALM,
  { op: 'JMP', target: 9 },
  { op: 'LOOP_BEGIN', end: 8, count: 3 },
  BREATH,
  { op: 'LOOP_END', begin: 6 },
  HALT,
];

// 只有「则」分支的如果：走不成立就是整个分支被跳过，本 tick 一点产出都没有。
const IF_THEN_ONLY: readonly Op[] = [
  { op: 'LOAD', key: 'demon' },
  { op: 'PUSH', value: 0.5 },
  { op: 'CMP', arg: '>' },
  { op: 'JMP_IF_FALSE', target: 6 },
  BREATH,
  { op: 'JMP', target: 6 },
  HALT,
];

function preview(code: readonly Op[], realmIndex = 0) {
  return previewCurve({ content: CONTENT, realmIndex, code });
}

describe('预览常量与窗口（架构 §曲线预览：简化模型跑 600 tick）', () => {
  it('60 秒 × 每秒一个点 = 600 tick / 60 点', () => {
    expect(PREVIEW_SECONDS).toBe(60);
    expect(PREVIEW_TICKS).toBe(600);
    expect(PREVIEW_POINTS).toBe(60);
    expect(PREVIEW_TICKS / PREVIEW_POINTS).toBe(TICKS_PER_SEC);
  });

  it('点数就是 60，最后一格是第 60 秒末的累计产出', () => {
    const result = preview([BREATH, HALT]);
    expect(result.points.length).toBe(PREVIEW_POINTS);
    expect(result.points[0]).toBe(10);
    expect(result.points[59]).toBe(600);
  });
});

describe('静态线性化（LOOP 按字面展开、如果走「不成立」）', () => {
  it('顺序 = 执行序，k 就是序号（契约 §2.2 的每 tick 第 N 次动作从 1 起）', () => {
    const linear = linearizeProgram([BREATH, BREATH, BREATH, HALT]);
    expect(linear.kinds).toEqual(['breath', 'breath', 'breath']);
    expect(linear.truncated).toBe(false);
    // 三块并排 = 每 tick 三次动作：k=2 的边际乘数是 1/(1+0.25)=0.8
    expect(preview([BREATH, BREATH, BREATH, HALT]).perTick).toBeCloseTo(1 + 0.8 + 1 / 1.5, 15);
  });

  it('循环按字面次数展开，LOOP_BEGIN / LOOP_END 也各计一步（预算口径与 VM 相同）', () => {
    const code: readonly Op[] = [
      { op: 'LOOP_BEGIN', end: 2, count: 4 },
      BREATH,
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ];
    const linear = linearizeProgram(code);
    expect(linear.kinds.length).toBe(4);
    // BEGIN 1 步 + 4×(ACTION+END) 8 步 + HALT 1 步
    expect(linear.steps).toBe(10);
  });

  it('「如果」走不成立：则分支被跳过，否则分支照跑', () => {
    const linear = linearizeProgram(IF_ELSE_REPEAT);
    expect(linear.kinds).toEqual(['breath', 'breath', 'breath']);
  });

  it('没有否则分支的如果 = 本 tick 什么都不执行', () => {
    const linear = linearizeProgram(IF_THEN_ONLY);
    expect(linear.kinds).toEqual([]);
  });

  it('预算截断：200 步之后停止，并如实标 truncated（不是「程序就这么长」）', () => {
    const code: readonly Op[] = [...Array.from({ length: 210 }, () => BREATH), HALT];
    const linear = linearizeProgram(code);
    expect(linear.steps).toBe(BASE_BUDGET);
    expect(linear.kinds.length).toBe(BASE_BUDGET);
    expect(linear.truncated).toBe(true);
  });

  it('空程序与只有 HALT 都是 0 个动作，不抛异常', () => {
    expect(linearizeProgram([]).kinds).toEqual([]);
    expect(linearizeProgram([HALT]).kinds).toEqual([]);
  });

  it('回边跳回自己（改档出来的坏 IR）由预算收口，不会把展开跑成死循环', () => {
    const code: readonly Op[] = [{ op: 'JMP', target: 0 }];
    const linear = linearizeProgram(code);
    expect(linear.steps).toBe(BASE_BUDGET);
    expect(linear.truncated).toBe(true);
    expect(linear.kinds).toEqual([]);
  });
});

describe('曲线数值：与契约 §3 的真表对得上', () => {
  it('炼气单块吐纳：1/tick = 10/秒，1e3 阈值预计 100 秒达标', () => {
    const result = preview([BREATH, HALT]);
    expect(result.perTick).toBe(1);
    expect(result.perSec).toBe(10);
    expect(result.threshold).toBe(1e3);
    expect(result.etaSec).toBe(100);
    // 100 秒 > 60 秒窗口：图上到不了阈值，这句话得由 core 说，不是 UI 猜
    expect(result.reachesInWindow).toBe(false);
  });

  it('炼气双块：边际递减 1/(1+0.25)=0.8 也进模型，18/秒 → 预计 56 秒', () => {
    const result = preview([BREATH, BREATH, HALT]);
    expect(result.perTick).toBeCloseTo(1.8, 12);
    expect(result.perSec).toBeCloseTo(18, 12);
    expect(result.etaSec).toBe(56);
  });

  it('炼气三块：循环 3 次与并排 3 块是同一个数（模型只看执行序）', () => {
    const loop: readonly Op[] = [
      { op: 'LOOP_BEGIN', end: 2, count: 3 },
      BREATH,
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ];
    expect(preview(loop).perTick).toBeCloseTo(preview([BREATH, BREATH, BREATH, HALT]).perTick, 15);
    expect(preview(loop).etaSec).toBe(41);
  });

  it('被动是与动作产出并列的加法项：筑基单块 = 1×3 + 0.5 = 3.5/tick', () => {
    const result = preview([BREATH, HALT], 1);
    expect(result.perTick).toBeCloseTo(3.5, 12);
    expect(result.threshold).toBe(1e4);
    expect(result.etaSec).toBe(286);
  });

  it('调息的 baseGain 是 0：产出照 0 算，心魔增量整个不进模型（§7.2 同口径）', () => {
    const result = preview([CALM, HALT]);
    expect(result.perTick).toBe(0);
    expect(result.etaSec).toBeNull();
    expect(result.points.every((value) => value === 0)).toBe(true);
    expect(result.reachesInWindow).toBe(false);
  });

  it('零产出时预计秒数是 null，不是 Infinity（UI 画不出 Infinity）', () => {
    expect(preview([HALT]).etaSec).toBeNull();
    expect(preview(IF_THEN_ONLY).etaSec).toBeNull();
  });

  it('预算截断进产出：210 块只算前 200 步，perTick 约 16.1 而不是 210', () => {
    const code: readonly Op[] = [...Array.from({ length: 210 }, () => BREATH), HALT];
    const result = preview(code);
    expect(result.truncated).toBe(true);
    expect(result.perTick).toBeGreaterThan(16);
    expect(result.perTick).toBeLessThan(16.5);
  });

  it('金丹 / 元婴用各自行的 actionMult 与被动', () => {
    expect(preview([BREATH, HALT], 2).perTick).toBeCloseTo(1 * 25 + 3, 12);
    expect(preview([BREATH, HALT], 3).perTick).toBeCloseTo(1 * 100 + 15, 12);
  });
});

// ——————————————————————————————————————————————————————————————
// 预览不能是「另一套数学」：同一份程序，真 VM 跑 600 tick 的累计必须与曲线末点逐位相同。
// 参照口径照 runtime.run() 那行式子；心魔钉 0 让杂念乘数恒 1（模型不建模它，这是唯一的差项）。
// ——————————————————————————————————————————————————————————————
function vmLedger(code: readonly Op[], realmIndex: number): Qi {
  const realm = CONTENT.realms[realmIndex]!;
  const sink = demonlessSink(() => makeActionSink({ content: CONTENT, realmIndex }));
  let qi = 0;
  const vm = new Vm({
    content: CONTENT,
    sink,
    vars: () => ({ qi, rate: 0, demon: 0, realm: realm.id, budget: BASE_BUDGET }),
  });
  vm.installUnchecked([{ id: 'p0', code }]);
  let total = Qi.zero;
  for (let tick = 0; tick < PREVIEW_TICKS; tick += 1) {
    const result = vm.tick();
    total = Qi.add(total, Qi.add(result.gain, passivePerTick(realm)));
    qi = total;
  }
  return total;
}

describe('预览 ↔ 真 VM 逐位对齐（无心魔、无杂念、无玉简时不该有第二条口径）', () => {
  const CASES: readonly { readonly name: string; readonly code: readonly Op[]; readonly realmIndex: number }[] = [
    { name: '炼气单块', code: [BREATH, HALT], realmIndex: 0 },
    { name: '炼气双块', code: [BREATH, BREATH, HALT], realmIndex: 0 },
    { name: '筑基单块（含被动）', code: [BREATH, HALT], realmIndex: 1 },
    { name: '循环 4 次', code: [{ op: 'LOOP_BEGIN', end: 2, count: 4 }, BREATH, { op: 'LOOP_END', begin: 0 }, HALT], realmIndex: 0 },
    { name: '如果/否则 + 循环（参考策略）', code: IF_ELSE_REPEAT, realmIndex: 0 },
    { name: '只有则分支', code: IF_THEN_ONLY, realmIndex: 0 },
    { name: '210 块（预算截断）', code: [...Array.from({ length: 210 }, () => BREATH), HALT], realmIndex: 2 },
  ];

  it.each(CASES)('$name：曲线末点 = 真 VM 600 tick 的累计产出', ({ code, realmIndex }) => {
    const result = preview(code, realmIndex);
    expect(result.points[PREVIEW_POINTS - 1]).toBe(vmLedger(code, realmIndex));
  });

  it('每 10 tick 采一个点：第 k 个点等于真 VM 跑到 k×10 tick 的累计', () => {
    const result = preview([BREATH, BREATH, HALT]);
    const sink = demonlessSink(() => makeActionSink({ content: CONTENT, realmIndex: 0 }));
    const vm = new Vm({ content: CONTENT, sink, vars: () => ({ qi: 0, rate: 0, demon: 0, realm: 0, budget: BASE_BUDGET }) });
    vm.installUnchecked([{ id: 'p0', code: [BREATH, BREATH, HALT] }]);
    let total = Qi.zero;
    const sampled: Qi[] = [];
    for (let tick = 1; tick <= PREVIEW_TICKS; tick += 1) {
      const result2 = vm.tick();
      total = Qi.add(total, Qi.add(result2.gain, passivePerTick(CONTENT.realms[0]!)));
      if (tick % TICKS_PER_SEC === 0) sampled.push(total);
    }
    expect(result.points).toEqual(sampled);
  });

  it('累计是逐 tick 相加，不是「速率 × 秒」：0.1 这类不精确数不许被抹平', () => {
    // 筑基被动 0.5/tick + 动作 3：perTick 3.5 精确，但金丹起的乘数链走的是浮点分母，
    // 这里钉「点数序列 = 前向累加」而不是「= perSec × 秒数」。
    const result = preview([BREATH, HALT], 3);
    expect(result.points[0]).toBe(result.perTick * TICKS_PER_SEC);
    expect(result.points[59]).toBe(vmLedger([BREATH, HALT], 3));
  });
});

// ——————————————————————————————————————————————————————————————
// 批次 2：曲线第二条线。裁定 1「心魔预测计调息的 −0.0005，法宝/功法书的 demonMult 不计」，
// 这一节钉的就是那条：没有第二条数学，撞线点由 core 说，UI 只负责画。
// ——————————————————————————————————————————————————————————————
const DEMON_PER_BREATH = 0.00005; // 契约 §2.2 的 demonGrowth 基线（demonBase 缺省值）
const CALM_DEMON_DELTA = -0.0005; // actions.json 里 calm 那一行的 demonDelta

describe('心魔预测线（demonPoints / backlashAtSec）', () => {
  it('纯吐纳无被动：每 tick 0.00005，第 30 秒 0.015，60 秒不撞线', () => {
    const result = preview([BREATH, HALT]);
    expect(result.demonPoints.length).toBe(PREVIEW_POINTS);
    expect(result.demonPoints[29]).toBeCloseTo(0.015, 12);
    expect(result.demonPoints[59]).toBeCloseTo(0.03, 12);
    expect(result.backlashAtSec).toBeNull();
  });

  it('210 块（预算截断）：心魔只算展开出来的 200 槽，与灵力同一个截断口径', () => {
    const code: readonly Op[] = [...Array.from({ length: 210 }, () => BREATH), HALT];
    const result = preview(code);
    expect(result.truncated).toBe(true);
    // 200 槽 × 0.00005 = 0.01/tick = 0.1/秒 → 第 10 秒撞线。第 201–210 块不许进这条账。
    // 实测 11 秒：0.01 累加 100 次落在 0.9999999999999999，多走一跳才越过火线——向上取整 thus 报 11。
    expect(result.backlashAtSec).toBe(11);
    expect(result.demonPoints.length).toBe(11);
    expect(result.demonPoints[8]).toBeCloseTo(0.9, 12);
    expect(result.demonPoints[10]).toBe(1);
    // 裁定 2：qi 线不折、不因走火打折，还是满 60 点。
    expect(result.points.length).toBe(PREVIEW_POINTS);
  });

  it('循环 3 次（深度 1）：增长项 ×1.5，第 6 秒 = 60 tick × 3 × 0.000075', () => {
    const loop: readonly Op[] = [
      { op: 'LOOP_BEGIN', end: 2, count: 3 },
      BREATH,
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ];
    const result = preview(loop);
    // 第 k 个点是「第 k+1 秒末」，所以 index 5 是 60 tick 的累计，不是 30。
    expect(result.demonPoints[5]).toBeCloseTo(60 * 3 * DEMON_PER_BREATH * 1.5, 12);
    expect(result.demonPoints[5]).toBeCloseTo(0.0135, 12);
  });

  it('调息进模型（裁定 1）：吐纳 + 调息把每 tick 的账压成 0.00005 − 0.0005，60 秒恒 0', () => {
    const withCalm = preview([BREATH, CALM, HALT]);
    expect(withCalm.demonPoints[0]).toBe(0);
    expect(withCalm.demonPoints[59]).toBe(0);
    expect(withCalm.backlashAtSec).toBeNull();
    // 单独一块调息同一条路：负增长夹在 0，不许画出一条往下掉的线。
    expect(preview([CALM, HALT]).demonPoints[59]).toBe(0);
  });

  it('压不压得住看得见：40 块吐纳 50 秒撞线，同机器加 4 块调息后账正好抵平', () => {
    const breaths: readonly Op[] = [...Array.from({ length: 40 }, () => BREATH), HALT];
    const damped: readonly Op[] = [...Array.from({ length: 40 }, () => BREATH), CALM, CALM, CALM, CALM, HALT];
    const hot = preview(breaths);
    // 40 × 0.00005 = 0.002/tick = 0.02/秒 → 1.0 要 50 秒（窗口内，面板要出红点那句话）。
    expect(hot.demonPoints[48]).toBeCloseTo(0.98, 12);
    expect(hot.backlashAtSec).toBe(50);
    expect(hot.demonPoints.length).toBe(50);
    // 4 × (−0.0005) = −0.002 正好抵平：这就是裁定 1 要能回答的那个问题。
    expect(40 * DEMON_PER_BREATH + 4 * CALM_DEMON_DELTA).toBe(0);
    const cool = preview(damped);
    expect(cool.backlashAtSec).toBeNull();
    // 夹 0..1 之后只剩浮点零头：抵平就是抵平，不许画出往下掉的线。
    expect(cool.demonPoints[59]).toBeCloseTo(0, 15);
    // 灵力两条一样：调息 baseGain 0、且排在第 41–44 槽，前 40 槽的乘数一个没动 —— 面板上这正是「白捡的减压」。
    expect(cool.points[59]).toBe(hot.points[59]);
  });

  it('撞线那条线在命中点截断 + 报秒数（裁定 2：qi 线不折，demon 线收住）', () => {
    // 换基线最省事：同一份程序只把 demonBase 拧大，走的还是那条累加与判据。
    const result = previewCurve({ content: CONTENT, realmIndex: 0, code: [BREATH, HALT], demonBase: 0.0025 });
    // 0.0025/tick → 理论 400 tick = 40 秒；实测 41：第 400 tick 的和落在 0.9999999999999999，
    // 判据要的是「越过」，于是多走一跳，向上取整成 41。面板说的就是这个数，不四舍五入回 40。
    expect(result.backlashAtSec).toBe(41);
    expect(result.demonPoints.length).toBe(41);
    expect(result.demonPoints[40]).toBe(1);
    // 灵力线不受影响：还是满 60 点，撞线那一秒的产出照常累计。
    expect(result.points.length).toBe(PREVIEW_POINTS);
    expect(result.points[39]).toBe(400);
  });

  it('心魔与灵力共用一次展开：未知 actionId 两边都记 0，预览不崩页面', () => {
    const result = previewCurve({ content: CONTENT, realmIndex: 0, code: [{ op: 'ACTION', actionId: 'removed' }, HALT] });
    expect(result.perTick).toBe(0);
    expect(result.demonPoints[59]).toBe(0);
    expect(result.backlashAtSec).toBeNull();
  });
});

describe('面板要说的话由 core 给齐（HUD 不算术）', () => {
  it('realmIndex 跟着结果走：换境界的那一次编译要重新起基线', () => {
    expect(preview([BREATH, HALT], 2).realmIndex).toBe(2);
  });

  it('60 秒内能达标的程序，reachesInWindow 为真（阈值参考线落在图内）', () => {
    const lianqi = preview([...Array.from({ length: 20 }, () => BREATH), HALT]);
    expect(lianqi.perSec).toBeGreaterThan(1e3 / PREVIEW_SECONDS);
    expect(lianqi.reachesInWindow).toBe(true);
    expect(lianqi.etaSec).not.toBeNull();
    expect(lianqi.etaSec! <= PREVIEW_SECONDS).toBe(true);
  });

  it('未知 actionId 不抛：按 0 产出处理并留 steps（存档里的旧积木不该白屏）', () => {
    const result = previewCurve({ content: CONTENT, realmIndex: 0, code: [{ op: 'ACTION', actionId: 'removed' }, HALT] });
    expect(result.perTick).toBe(0);
    expect(result.etaSec).toBeNull();
  });
});
