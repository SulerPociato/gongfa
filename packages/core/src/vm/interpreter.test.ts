import { describe, expect, it, vi } from 'vitest';
import { loadContent } from '../content/loader';
import type { Content } from '../content/schema';
import { BASE_BUDGET, type Clock } from '../types';
import { Vm, type ActionRequest, type ActionSink, type TickResult, type VmSnapshot } from './interpreter';
import type { StallEvent, VmEvent } from './events';
import { MAX_LOOP_DEPTH, type Op, type Program } from './program';

const CONTENT: Content = loadContent({
  actions: [
    { id: 'breath', baseGain: 1, demonDelta: 0, kind: 'gain' },
    { id: 'calm', baseGain: 0, demonDelta: -0.0005, kind: 'calm' },
  ],
  realms: [{ id: 0, name: { zh: '炼气' }, threshold: '1e3', passivePerSec: 0, actionMult: 1 }],
});

const HALT: Op = { op: 'HALT' };
const BREATH: Op = { op: 'ACTION', actionId: 'breath' };

// 契约 §4.2 的循环形状：LOOP_BEGIN@0 / ACTION@1 / LOOP_END@2 / HALT@3，单 tick 8 步
const LOOP3: readonly Op[] = [
  { op: 'LOOP_BEGIN', end: 2, count: 3 },
  BREATH,
  { op: 'LOOP_END', begin: 0 },
  HALT,
];

// 10×10×10 = 1000 次动作，等价于 while(true)：必然被 200 步预算截断
const NESTED_LOOP: readonly Op[] = [
  { op: 'LOOP_BEGIN', end: 6, count: 10 },
  { op: 'LOOP_BEGIN', end: 5, count: 10 },
  { op: 'LOOP_BEGIN', end: 4, count: 10 },
  BREATH,
  { op: 'LOOP_END', begin: 2 },
  { op: 'LOOP_END', begin: 1 },
  { op: 'LOOP_END', begin: 0 },
  HALT,
];

function program(code: readonly Op[], id = 'p0'): Program {
  return { id, code };
}

function recorder(produce: (request: ActionRequest) => { qi: number; demonDelta: number; stepCost?: number }): {
  calls: ActionRequest[];
  sink: ActionSink;
} {
  const calls: ActionRequest[] = [];
  return {
    calls,
    sink: {
      execute(request) {
        calls.push(request);
        return produce(request);
      },
    },
  };
}

const UNIT_SINK: ActionSink = { execute: () => ({ qi: 1, demonDelta: 0 }) };

interface LoadOptions {
  id?: string;
  sink?: ActionSink;
  vars?: () => VmSnapshot;
  budgetPool?: number;
  events?: VmEvent[];
}

function loadedVm(code: readonly Op[], options: LoadOptions = {}): Vm {
  const vm = new Vm({
    content: CONTENT,
    sink: options.sink ?? UNIT_SINK,
    budgetPool: options.budgetPool,
    vars: options.vars,
    onEvent: options.events === undefined ? undefined : (event) => options.events?.push(event),
  });
  const result = vm.loadPrograms([program(code, options.id)]);
  if (!result.ok) throw new Error(`装载失败：${JSON.stringify(result.errors)}`);
  return vm;
}

describe('ACTION 的 k 传递', () => {
  it('循环 3 次：k 依次 1/2/3，pc 恒为动作所在指令', () => {
    const rec = recorder(({ k }) => ({ qi: 1, demonDelta: 0.00005 * 1.5 * (k > 0 ? 1 : 1) }));
    const vm = loadedVm(LOOP3, { sink: rec.sink });
    const result = vm.tick();

    expect(rec.calls.map((call) => call.k)).toEqual([1, 2, 3]);
    expect(rec.calls.map((call) => call.actionId)).toEqual(['breath', 'breath', 'breath']);
    expect(rec.calls.map((call) => call.pc)).toEqual([1, 1, 1]);
    expect(result.gain).toBe(3);
    expect(result.demonDelta).toBeCloseTo(0.000225, 12);
  });

  it('k 进产出：qi=k 时本 tick gain 为三角和 6', () => {
    const rec = recorder(({ k }) => ({ qi: k, demonDelta: 0 }));
    const result = loadedVm(LOOP3, { sink: rec.sink }).tick();
    expect(result.gain).toBe(6);
  });

  it('k 每个 tick 重新从 1 计数', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const vm = loadedVm(LOOP3, { sink: rec.sink });
    vm.tick();
    vm.tick();
    expect(rec.calls.map((call) => call.k)).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('loopDepth = 运行期循环栈深度（契约 §2.2.1，不进 IR）', () => {
    const code: readonly Op[] = [
      BREATH, // 0 栈外
      { op: 'LOOP_BEGIN', end: 3, count: 2 },
      BREATH, // 2 深度 1
      { op: 'LOOP_END', begin: 1 },
      { op: 'LOOP_BEGIN', end: 8, count: 2 },
      { op: 'LOOP_BEGIN', end: 7, count: 2 },
      BREATH, // 6 深度 2
      { op: 'LOOP_END', begin: 5 },
      { op: 'LOOP_END', begin: 4 },
      HALT,
    ];
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const result = loadedVm(code, { sink: rec.sink }).tick();
    // 外层回边跳回 begin+1，会重新执行内层 LOOP_BEGIN，所以深度 2 的动作有 4 次（2 轮 × 2 次）
    expect(rec.calls.map((call) => call.loopDepth)).toEqual([0, 1, 1, 2, 2, 2, 2]);
    expect(rec.calls.map((call) => call.k)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 实测 20 步 = 7 ACTION + 4 次 LOOP_BEGIN + 8 次 LOOP_END + 1 HALT（每条指令算 1 步，契约 §4.3）
    expect(result.steps).toBe(20);
  });
});

describe('循环语义（契约 §4.2）', () => {
  it('count=3 走 LOOP_END 回边到 begin+1，总步数 8', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const result = loadedVm(LOOP3, { sink: rec.sink }).tick();
    // 若实现成“跳回 begin”，LOOP_BEGIN 会被重复执行，步数变成 10 且 k 序列多出 4
    expect(result.steps).toBe(8);
    expect(rec.calls.map((call) => call.k)).toEqual([1, 2, 3]);
  });

  it('count=1 只执行一次，弹栈后落到 HALT', () => {
    const code: readonly Op[] = [
      { op: 'LOOP_BEGIN', end: 2, count: 1 },
      BREATH,
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ];
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const result = loadedVm(code, { sink: rec.sink }).tick();
    expect(rec.calls.length).toBe(1);
    expect(result.steps).toBe(4);
    expect(result.gain).toBe(1);
  });

  it('两个动作槽共享同一个 k 计数器', () => {
    const code: readonly Op[] = [
      BREATH,
      { op: 'ACTION', actionId: 'calm' },
      BREATH,
      HALT,
    ];
    const rec = recorder(({ k }) => ({ qi: k, demonDelta: 0 }));
    const result = loadedVm(code, { sink: rec.sink }).tick();
    expect(rec.calls.map((call) => [call.k, call.actionId])).toEqual([
      [1, 'breath'],
      [2, 'calm'],
      [3, 'breath'],
    ]);
    expect(result.gain).toBe(6);
  });
});

describe('预算与 stall', () => {
  it('10^3 次动作的死循环在 200 步被截断，reason=budget', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const events: VmEvent[] = [];
    const vm = loadedVm(NESTED_LOOP, { sink: rec.sink, events });
    const result = vm.tick();
    const stall = result.stall;

    expect(stall).not.toBeNull();
    expect(stall?.reason).toBe('budget');
    expect(stall?.steps).toBe(BASE_BUDGET);
    // 每轮外层 22 步（LOOP_BEGIN@2 + 10×(ACTION+LOOP_END) + LOOP_END@5），2 + 22×9 = 200 正好停在 pc 2
    expect(stall?.pc).toBe(2);
    expect(rec.calls.length).toBe(90);
    expect(result.gain).toBe(rec.calls.length);
    expect(stall?.pc).toBeLessThan(7);
    expect(vm.currentTick).toBe(1);
    console.log(`预算截断实测：steps=${stall?.steps} pc=${stall?.pc} 动作次数=${rec.calls.length}（未截断则为 1000）`);
  });

  it('budget 事件字段齐全，且与 TickResult.stall 是同一对象', () => {
    const events: VmEvent[] = [];
    const vm = loadedVm(NESTED_LOOP, { events });
    const result = vm.tick();
    const stall = result.stall as StallEvent;

    expect(Object.keys(stall).sort()).toEqual(['pc', 'programId', 'reason', 'steps', 't', 'tick']);
    expect(stall.t).toBe('stall');
    expect(stall.programId).toBe('p0');
    expect(stall.tick).toBe(1);
    expect(events.length).toBe(1);
    expect(events[0]).toBe(stall);
  });

  it('每个 tick 独立发 stall，预算不跨 tick 累计', () => {
    const vm = loadedVm(NESTED_LOOP);
    const first = vm.tick();
    const second = vm.tick();
    expect(first.stall?.tick).toBe(1);
    expect(second.stall?.tick).toBe(2);
    expect(second.stall?.steps).toBe(BASE_BUDGET);
  });

  it('budgetPool 可覆盖，3 步就截断', () => {
    const code: readonly Op[] = [BREATH, BREATH, BREATH, HALT];
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const result = loadedVm(code, { sink: rec.sink, budgetPool: 3 }).tick();
    expect(result.steps).toBe(3);
    expect(result.stall?.pc).toBe(3);
    expect(rec.calls.length).toBe(3);
  });

  it('非常量除零发 stall reason=divZero', () => {
    const code: readonly Op[] = [
      { op: 'PUSH', value: 1 },
      { op: 'LOAD', key: 'qi' },
      { op: 'DIV' },
      HALT,
    ];
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const result = loadedVm(code, { sink: rec.sink, vars: () => ({ qi: 0, rate: 0, demon: 0, realm: 0, budget: 200 }) }).tick();

    expect(result.stall?.reason).toBe('divZero');
    expect(result.stall?.pc).toBe(2);
    expect(result.steps).toBe(3);
    expect(result.gain).toBe(0);
    expect(rec.calls.length).toBe(0);
  });

  it('常量除零在装载阶段就被拒，一个程序都不装', () => {
    const vm = new Vm({ content: CONTENT, sink: UNIT_SINK });
    const result = vm.loadPrograms([program([{ op: 'PUSH', value: 10 }, { op: 'PUSH', value: 0 }, { op: 'DIV' }, HALT])]);
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.check)).toContain('div-zero');
    expect(vm.programs.length).toBe(0);
  });
});

describe('LOAD / CMP / JMP_IF_FALSE', () => {
  const GUARD: readonly Op[] = [
    { op: 'LOAD', key: 'demon' },
    { op: 'PUSH', value: 0 },
    { op: 'CMP', arg: '>' },
    { op: 'JMP_IF_FALSE', target: 5 },
    BREATH,
    HALT,
  ];

  function snapshot(demon: number): () => VmSnapshot {
    return () => ({ qi: 0, rate: 0, demon, realm: 0, budget: BASE_BUDGET });
  }

  it('demon>0 走产出分支，demon=0 跳到 HALT', () => {
    const on = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const onResult = loadedVm(GUARD, { sink: on.sink, vars: snapshot(0.6) }).tick();
    expect(onResult.gain).toBe(1);
    expect(onResult.steps).toBe(6);

    const off = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const offResult = loadedVm(GUARD, { sink: off.sink, vars: snapshot(0) }).tick();
    expect(offResult.gain).toBe(0);
    expect(offResult.steps).toBe(5);
    expect(off.calls.length).toBe(0);
  });

  it('vars 每个 tick 重新读取', () => {
    let demon = 0.6;
    const vm = loadedVm(GUARD, { vars: () => ({ qi: 0, rate: 0, demon, realm: 0, budget: BASE_BUDGET }) });
    expect(vm.tick().gain).toBe(1);
    demon = 0;
    expect(vm.tick().gain).toBe(0);
  });
});

describe('多程序：stall 只中止当前程序', () => {
  const DIV_ZERO: readonly Op[] = [
    { op: 'PUSH', value: 1 },
    { op: 'LOAD', key: 'qi' },
    { op: 'DIV' },
    HALT,
  ];
  const ONE_ACTION: readonly Op[] = [BREATH, HALT];

  function twoPrograms(
    first: readonly Op[],
    second: readonly Op[],
    deps: { sink: ActionSink; vars?: () => VmSnapshot; events: VmEvent[] }
  ): Vm {
    const vm = new Vm({
      content: CONTENT,
      sink: deps.sink,
      vars: deps.vars,
      onEvent: (event) => deps.events.push(event),
    });
    const result = vm.loadPrograms([program(first, 'pA'), program(second, 'pB')]);
    if (!result.ok) throw new Error(`装载失败：${JSON.stringify(result.errors)}`);
    return vm;
  }

  it('pA 非常量除零中止，pB 照常产出（不因前序 stall 丢一整 tick）', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const events: VmEvent[] = [];
    const vm = twoPrograms(DIV_ZERO, ONE_ACTION, {
      sink: rec.sink,
      vars: () => ({ qi: 0, rate: 0, demon: 0, realm: 0, budget: BASE_BUDGET }),
      events,
    });
    const result = vm.tick();

    expect(result.stall?.reason).toBe('divZero');
    expect(result.stall?.programId).toBe('pA');
    expect(result.stall?.pc).toBe(2);
    expect(result.gain).toBe(1);
    expect(result.steps).toBe(5); // pA 的 3 步 + pB 的 2 步
    expect(events.map((event) => event.programId)).toEqual(['pA']);
  });

  it('预算是每 tick 总池：pA 耗尽后 pB 在 pc 0 中止，stall 只带第一个', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const events: VmEvent[] = [];
    const vm = twoPrograms(NESTED_LOOP, ONE_ACTION, { sink: rec.sink, events });
    const result = vm.tick();

    expect(result.stall?.programId).toBe('pA');
    expect(result.stall?.reason).toBe('budget');
    expect(result.gain).toBe(90);
    expect(events.map((event) => [event.programId, event.pc, event.reason])).toEqual([
      ['pA', 2, 'budget'],
      ['pB', 0, 'budget'],
    ]);
    console.log(
      `双程序实测：pA 动作 ${rec.calls.length} 次 gain=${result.gain} steps=${result.steps} ｜ pB 拿到 stall ${JSON.stringify(events[1])}`,
    );
  });
});

describe('installUnchecked：verifier 之外的 IR（存档快进路径）', () => {
  function bareVm(sink: ActionSink, code: readonly Op[]): Vm {
    const vm = new Vm({ content: CONTENT, sink });
    vm.installUnchecked([program(code)]);
    return vm;
  }

  it('count=0 的循环体执行 0 次，pc 直接落到 end+1', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const code: readonly Op[] = [
      { op: 'LOOP_BEGIN', end: 2, count: 0 },
      BREATH, // 循环体：一次都不该执行
      { op: 'LOOP_END', begin: 0 }, // 唯一弹栈点，被跳过
      { op: 'ACTION', actionId: 'calm' }, // end+1 = 3，落点探针
      HALT,
    ];
    const result = bareVm(rec.sink, code).tick();

    expect(rec.calls.map((call) => [call.actionId, call.pc, call.k])).toEqual([['calm', 3, 1]]);
    expect(result.steps).toBe(3);
    expect(result.stall).toBeNull();
  });

  it('count=0 不占帧：连排 16 个之后真循环照跑，泄帧会在第 17 次压帧撞 loopLimit', () => {
    const code: Op[] = [];
    for (let i = 0; i < MAX_LOOP_DEPTH; i++) {
      const begin = code.length;
      code.push({ op: 'LOOP_BEGIN', end: begin + 2, count: 0 }, BREATH, { op: 'LOOP_END', begin });
    }
    const begin = code.length;
    code.push({ op: 'LOOP_BEGIN', end: begin + 2, count: 2 }, { op: 'ACTION', actionId: 'calm' }, { op: 'LOOP_END', begin }, HALT);

    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const result = bareVm(rec.sink, code).tick();

    expect(result.stall).toBeNull();
    expect(rec.calls.map((call) => [call.actionId, call.k])).toEqual([
      ['calm', 1],
      ['calm', 2],
    ]);
    // 16 个 count=0 各 1 步（只执行 LOOP_BEGIN）+ 真循环 6 步（LB + 2×(ACTION+LE) + HALT）
    expect(result.steps).toBe(MAX_LOOP_DEPTH + 6);
    console.log(`installUnchecked 防泄帧实测：count=0 ×${MAX_LOOP_DEPTH} + count=2 ×1 → steps=${result.steps} 动作=${rec.calls.length} stall=${JSON.stringify(result.stall)}`);
  });
});

describe('装载与确定性', () => {
  it('非法 IR 不装载，错误带 programId 前缀', () => {
    const vm = new Vm({ content: CONTENT, sink: UNIT_SINK });
    const result = vm.loadPrograms([program([{ op: 'ACTION', actionId: 'herb' }, HALT], 'pX')]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('[pX]');
    expect(vm.programs).toEqual([]);
    expect(vm.tick().stall).toBeNull();
  });

  it('没有程序时 tick 返回全零，不抛错', () => {
    const vm = new Vm({ content: CONTENT, sink: UNIT_SINK });
    expect(vm.loadPrograms([]).ok).toBe(true);
    const result = vm.tick();
    expect(result).toEqual({ tick: 1, steps: 0, gain: 0, demonDelta: 0, stall: null, profile: null });
  });

  it('同一 IR 两次运行逐字段一致', () => {
    const run = (): unknown[] => {
      const vm = loadedVm(NESTED_LOOP, { budgetPool: 40 });
      return Array.from({ length: 50 }, () => {
        const r = vm.tick();
        return [r.tick, r.steps, r.gain, r.demonDelta, r.stall?.pc ?? null, r.stall?.reason ?? null];
      });
    };
    expect(run()).toEqual(run());
  });
});

describe('吞吐（连跑 3 次取中位数）', () => {
  it('1 万 tick 的中位数 < 150ms，并打印实测', () => {
    const clock: Clock = { now: () => Date.now() };
    const samples: number[] = [];
    let lastSteps = 0;
    let lastTick = 0;

    for (let run = 0; run < 3; run++) {
      const vm = loadedVm(LOOP3);
      const startedAt = clock.now();
      let result = vm.tick();
      for (let i = 1; i < 10000; i++) result = vm.tick();
      samples.push(clock.now() - startedAt);
      lastSteps = result.steps;
      lastTick = vm.currentTick;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[1] ?? Number.NaN;
    console.log(
      `10000 tick ×3 实测：${samples.join(' / ')} ms ｜ 中位数 ${median} ms ｜ 阈值 150 ms ｜ 每 tick ${lastSteps} 步 = ${lastSteps * 10000} 步/次`,
    );

    expect(lastTick).toBe(10000);
    expect(lastSteps).toBe(8);
    expect(median).toBeLessThan(150);
  });
});

// 契约 §2.4：玉简把命中的那次 ACTION 计 0 步；算盘把每 tick 预算池抬高。
// 两条都必须在不装道具时一个字节都不改现有口径，所以先钉「缺省等价」，再钉「0 步不等于免死」。
describe('道具的两条 VM 口径（契约 §2.4，任务 7A）', () => {
  function bareVm(sink: ActionSink, code: readonly Op[], budgetPool?: number): Vm {
    const vm = new Vm({ content: CONTENT, sink, budgetPool });
    vm.installUnchecked([program(code)]);
    return vm;
  }

  it('stepCost 缺省与显式 1 逐字段一致：不装道具就是今天的 VM', () => {
    const absent = recorder(() => ({ qi: 1, demonDelta: 0.00005 }));
    const explicit = recorder(() => ({ qi: 1, demonDelta: 0.00005, stepCost: 1 }));
    const a = bareVm(absent.sink, LOOP3).tick();
    const b = bareVm(explicit.sink, LOOP3).tick();

    expect(b).toEqual(a);
    expect(b.steps).toBe(8);
    expect(a.steps).toBe(8);
  });

  it('stepCost=0 只免 ACTION 那一步：循环 3 次从 8 步降到 5 步', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0, stepCost: 0 }));
    const result = bareVm(rec.sink, LOOP3).tick();

    // LB + 3×(ACTION 0 步 + LOOP_END 1 步) + HALT = 1 + 3 + 1
    expect(result.steps).toBe(5);
    expect(rec.calls.length).toBe(3);
    expect(result.gain).toBe(3);
    console.log(`0 步 ACTION 实测：steps=${result.steps}（全额 8）动作=${rec.calls.length}`);
  });

  it('stepCost=0 掐不死 10^3 循环：回边 LOOP_END 照收 1 步，仍在 200 步截断', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0, stepCost: 0 }));
    const result = bareVm(rec.sink, NESTED_LOOP).tick();

    expect(result.stall?.reason).toBe('budget');
    expect(result.stall?.steps).toBe(BASE_BUDGET);
    // 全额时 90 次动作（现有那条口径不变），每步都免费的极端值是 163 次：多出来的全是回边买的单
    expect(rec.calls.length).toBe(163);
    expect(result.stall?.pc).toBe(3);
    console.log(`免费 ACTION 的预算截断实测：steps=${result.stall?.steps} 动作=${rec.calls.length} pc=${result.stall?.pc}`);
  });

  it('连循环结构都没有的后向 JMP：唯一收费的是 JMP 本身，动作 600 次照样停在 200 步', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0, stepCost: 0 }));
    const code: readonly Op[] = [BREATH, BREATH, BREATH, { op: 'JMP', target: 0 }];
    const result = bareVm(rec.sink, code).tick();

    expect(result.stall?.reason).toBe('budget');
    expect(result.stall?.steps).toBe(BASE_BUDGET);
    expect(rec.calls.length).toBe(600);
    expect(result.stall?.pc).toBe(0);
  });

  it('setBudget 换池不换 VM：ticksRun 连续，截断点从 200 步挪到 250 步', () => {
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const vm = bareVm(rec.sink, NESTED_LOOP);
    const first = vm.tick();
    expect(vm.budget).toBe(BASE_BUDGET);
    expect(first.stall?.steps).toBe(200);
    expect(rec.calls.length).toBe(90);

    vm.setBudget(BASE_BUDGET + 50);
    expect(vm.budget).toBe(250);
    rec.calls.length = 0;
    const second = vm.tick();

    expect(second.stall?.steps).toBe(250);
    expect(second.stall?.pc).toBe(4);
    expect(rec.calls.length).toBe(112);
    // 重建 VM 会把 ticksRun 归零，确定性回放就散了：这里必须是同一个实例连着数
    expect(second.tick).toBe(2);
    expect(vm.currentTick).toBe(2);
    console.log(`算盘预算实测：200 步 → 动作 90 ｜ 250 步 → 动作 112（+22）`);
  });

  it('LOAD budget 读的是 setBudget 之后的实时剩余预算', () => {
    // 剩余预算 > 240 才跑那一次动作：池 200 时第 1 步之后只剩 199（不进），池 250 时剩 249（进）
    const code: readonly Op[] = [
      { op: 'LOAD', key: 'budget' },
      { op: 'PUSH', value: 240 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 6 },
      BREATH,
      HALT,
      HALT,
    ];
    const rec = recorder(() => ({ qi: 1, demonDelta: 0 }));
    const vm = bareVm(rec.sink, code);
    const tight = vm.tick();
    expect(tight.gain).toBe(0);
    expect(tight.steps).toBe(5);

    vm.setBudget(250);
    rec.calls.length = 0;
    const wide = vm.tick();
    expect(wide.gain).toBe(1);
    expect(wide.steps).toBe(6);
    expect(wide.stall).toBeNull();
  });

  it('setBudget 的校验与构造参数同一条：非负整数，否则 RangeError 且池不变', () => {
    const vm = bareVm(UNIT_SINK, LOOP3);
    for (const bad of [2.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => vm.setBudget(bad)).toThrow(RangeError);
      expect(vm.budget).toBe(BASE_BUDGET);
    }
    vm.setBudget(0);
    expect(vm.budget).toBe(0);
  });
});

describe('fastForward（任务 7B 离线快进）', () => {
  // 让每个 tick 的产出与步数都不一样：sink 按调用序号给 qi，跨 tick 逐字段比对才有区分度。
  function steppingSink(): ActionSink {
    let n = 0;
    return { execute: () => ({ qi: (n += 1) / 7, demonDelta: (n % 3) / 1000 }) };
  }
  function vmWith(code: readonly Op[]): Vm {
    const vm = new Vm({ content: CONTENT, sink: steppingSink() });
    vm.installUnchecked([program(code)]);
    return vm;
  }

  it('与逐个 tick() 逐字段相等：连 steps 与 stall 都不许差', () => {
    for (const code of [LOOP3, NESTED_LOOP, [BREATH, HALT]]) {
      const oneByOne = vmWith(code);
      const fast = vmWith(code);
      const expected = Array.from({ length: 12 }, () => oneByOne.tick());
      const seen: TickResult[] = [];
      const ran = fast.fastForward(12, (result) => {
        seen.push(result);
      });

      expect(ran).toBe(12);
      expect(seen.length).toBe(12);
      // toEqual 是逐字段深比较：tick / steps / gain / demonDelta / stall{pc,steps,tick,reason} 全在里面
      expect(seen).toEqual(expected);
      expect(fast.currentTick).toBe(oneByOne.currentTick);
    }
  });

  it('早停后 ticksRun 等于已跑数，不是申请数（§7.2 停在阈值）', () => {
    const vm = vmWith(LOOP3);
    let seen = 0;
    const ran = vm.fastForward(50, () => {
      seen += 1;
      return seen === 3 ? 'stop' : undefined;
    });

    expect(ran).toBe(3);
    expect(seen).toBe(3);
    expect(vm.currentTick).toBe(3);
    // 计数器没有被早停打乱：下一次 tick 接着第 4 个走
    expect(vm.tick().tick).toBe(4);
  });

  it('0 tick 什么都不做；负数、小数、NaN 一律 RangeError 且不推进计数器', () => {
    const vm = vmWith(LOOP3);
    expect(vm.fastForward(0)).toBe(0);
    expect(vm.currentTick).toBe(0);
    for (const bad of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => vm.fastForward(bad)).toThrow(RangeError);
      expect(vm.currentTick).toBe(0);
    }
  });
});

// 批次 5：WHILE 控制流测试。
describe('WHILE 控制流（批次 5）', () => {
  function whileIr(opts: {
    key: 'qi' | 'rate' | 'demon' | 'realm' | 'budget';
    value: number;
    cmp: '<' | '>' | '==';
    body: readonly Op[];
  }): Op[] {
    const exitPc = 5 + opts.body.length + 1;
    return [
      { op: 'WHILE_BEGIN' }, // 0
      { op: 'LOAD', key: opts.key }, // 1
      { op: 'PUSH', value: opts.value }, // 2
      { op: 'CMP', arg: opts.cmp }, // 3
      { op: 'JMP_IF_FALSE', target: exitPc }, // 4
      ...opts.body, // 5..
      { op: 'WHILE_END', begin: 0 }, // n: 跳回 WHILE_BEGIN+1=1
      { op: 'WHILE_EXIT' }, // n+1
      HALT, // n+2
    ];
  }

  function makeVm(code: readonly Op[]): Vm {
    const vm = new Vm({
      content: CONTENT,
      sink: { execute: () => ({ qi: 1, demonDelta: 0 }) },
    });
    vm.installUnchecked([program(code)]);
    return vm;
  }

  it('基础 while：条件为假一次都不进', () => {
    const code = whileIr({ key: 'qi', value: 0, cmp: '<', body: [BREATH] });
    const vm = makeVm(code);
    const result = vm.tick();
    expect(result.steps).toBe(7);
    expect(result.gain).toBe(0);
    expect(result.stall).toBeNull();
  });

  it('帧泄漏防御：JMP 跳过 WHILE_EXIT → dev 下 console.error', () => {
    const code: Op[] = [
      { op: 'WHILE_BEGIN' },
      { op: 'PUSH', value: 0 },
      { op: 'JMP_IF_FALSE', target: 4 },
      { op: 'WHILE_END', begin: 0 },
      HALT,
    ];
    const vm = makeVm(code);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vm.tick();
    if ((import.meta as any).env?.DEV === true) {
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('循环栈非空'));
    }
    spy.mockRestore();
  });

  it('break in while：JMP{WHILE_EXIT} 跳出循环', () => {
    const exitPc = 6;
    const code: Op[] = [
      { op: 'WHILE_BEGIN' }, // 0
      { op: 'PUSH', value: 1 }, // 1
      { op: 'JMP_IF_FALSE', target: exitPc }, // 2
      BREATH, // 3
      { op: 'JMP', target: exitPc }, // 4: break
      { op: 'WHILE_END', begin: 0 }, // 5
      { op: 'WHILE_EXIT' }, // 6
      HALT, // 7
    ];
    const vm = makeVm(code);
    const result = vm.tick();
    expect(result.steps).toBe(7);
    expect(result.gain).toBe(1);
    expect(result.stall).toBeNull();
  });

  it('continue in while：JMP{WHILE_END} 跳回重判条件', () => {
    const code = whileIr({ key: 'qi', value: 0, cmp: '<', body: [
      { op: 'JMP', target: 5 }, // continue → WHILE_END
      BREATH,
    ]});
    const vm = makeVm(code);
    const result = vm.tick();
    expect(result.steps).toBe(7);
    expect(result.gain).toBe(0);
  });

  it('嵌套 while：内层 break 只跳内层', () => {
    const code: Op[] = [
      { op: 'WHILE_BEGIN' }, // 0: 外层
      { op: 'LOAD', key: 'qi' }, // 1
      { op: 'PUSH', value: 0 }, // 2
      { op: 'CMP', arg: '==' }, // 3
      { op: 'JMP_IF_FALSE', target: 16 }, // 4: 外层退出 → 外层 WHILE_EXIT
      { op: 'WHILE_BEGIN' }, // 5: 内层
      { op: 'LOAD', key: 'qi' }, // 6
      { op: 'PUSH', value: 0 }, // 7
      { op: 'CMP', arg: '==' }, // 8
      { op: 'JMP_IF_FALSE', target: 13 }, // 9: 内层退出 → 内层 WHILE_EXIT
      BREATH, // 10
      { op: 'JMP', target: 13 }, // 11: 内层 break → 内层 WHILE_EXIT
      { op: 'WHILE_END', begin: 5 }, // 12
      { op: 'WHILE_EXIT' }, // 13: 内层退出
      { op: 'JMP', target: 16 }, // 14: 外层也退出 → 外层 WHILE_EXIT
      { op: 'WHILE_END', begin: 0 }, // 15
      { op: 'WHILE_EXIT' }, // 16: 外层退出
      HALT, // 17
    ];
    const vm = makeVm(code);
    const result = vm.tick();
    // WHILE_BEGIN + LOAD + PUSH + CMP + JMP_IF_FALSE + WHILE_BEGIN + LOAD + PUSH + CMP + JMP_IF_FALSE + BREATH + JMP + WHILE_EXIT + JMP + WHILE_EXIT + HALT = 16
    expect(result.steps).toBe(16);
    expect(result.gain).toBe(1);
    expect(result.stall).toBeNull();
  });

  it('while 撞预算：条件永真 → stall', () => {
    const code: Op[] = [
      { op: 'WHILE_BEGIN' }, // 0
      { op: 'LOAD', key: 'budget' }, // 1
      { op: 'PUSH', value: 0 }, // 2
      { op: 'CMP', arg: '>' }, // 3
      { op: 'JMP_IF_FALSE', target: 7 }, // 4
      BREATH, // 5
      { op: 'WHILE_END', begin: 0 }, // 6
      { op: 'WHILE_EXIT' }, // 7
      HALT, // 8
    ];
    const vm = makeVm(code);
    const result = vm.tick();
    expect(result.stall).not.toBeNull();
    expect(result.stall?.reason).toBe('budget');
    expect(result.steps).toBe(200);
  });
});

// 批次 5 补充：BREAK op。弹最内层帧并跳到循环出口之后，不用 JMP 绕过 LOOP_END/WHILE_EXIT。
describe('BREAK op（批次 5 补充）', () => {
  function makeVm(code: readonly Op[]): Vm {
    const vm = new Vm({
      content: CONTENT,
      sink: { execute: () => ({ qi: 1, demonDelta: 0 }) },
    });
    vm.installUnchecked([program(code)]);
    return vm;
  }

  it('repeat 内 BREAK：弹帧后落到 LOOP_END+1，只执行 1 次动作', () => {
    const code: Op[] = [
      { op: 'LOOP_BEGIN', end: 2, count: 3 }, // 0
      BREATH, // 1
      { op: 'BREAK' }, // 2: 弹帧，跳到 LOOP_END(3)+1=4
      { op: 'LOOP_END', begin: 0 }, // 3
      HALT, // 4
    ];
    const vm = makeVm(code);
    const result = vm.tick();
    expect(result.gain).toBe(1);
    expect(result.stall).toBeNull();
    // LOOP_BEGIN + ACTION + BREAK + HALT = 4 步（LOOP_END 被跳过，不执行）
    expect(result.steps).toBe(4);
  });

  it('while 内 BREAK：弹帧后落到 WHILE_EXIT+1', () => {
    const code: Op[] = [
      { op: 'WHILE_BEGIN' }, // 0
      { op: 'PUSH', value: 1 }, // 1
      { op: 'JMP_IF_FALSE', target: 5 }, // 2
      BREATH, // 3
      { op: 'BREAK' }, // 4: 弹帧，跳到 WHILE_EXIT(6)+1=7
      { op: 'WHILE_END', begin: 1 }, // 5: begin = WHILE_BEGIN pc + 1 = 1
      { op: 'WHILE_EXIT' }, // 6
      HALT, // 7
    ];
    const vm = makeVm(code);
    const result = vm.tick();
    expect(result.gain).toBe(1);
    expect(result.stall).toBeNull();
    // WHILE_BEGIN + PUSH + JMP_IF_FALSE + BREATH + BREAK + HALT = 6
    expect(result.steps).toBe(6);
  });

  it('嵌套循环 BREAK 只弹最内层帧，外层继续', () => {
    const code: Op[] = [
      { op: 'LOOP_BEGIN', end: 7, count: 2 }, // 0: 外层
      { op: 'LOOP_BEGIN', end: 5, count: 5 }, // 1: 内层
      BREATH, // 2
      { op: 'BREAK' }, // 3: 弹内层帧，跳到 LOOP_END(5)+1=6
      BREATH, // 4: 不可达（BREAK 已跳出内层）
      { op: 'LOOP_END', begin: 1 }, // 5: 内层
      { op: 'LOOP_END', begin: 0 }, // 6: 外层
      HALT, // 7
    ];
    const vm = makeVm(code);
    const result = vm.tick();
    // 外层 2 轮 × 内层 1 次 BREATH = 2 次动作
    expect(result.gain).toBe(2);
    expect(result.stall).toBeNull();
  });
});
