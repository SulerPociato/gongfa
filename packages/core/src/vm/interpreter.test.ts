import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/loader';
import type { Content } from '../content/schema';
import { BASE_BUDGET, type Clock } from '../types';
import { Vm, type ActionRequest, type ActionSink, type VmSnapshot } from './interpreter';
import type { StallEvent, VmEvent } from './events';
import type { Op, Program } from './program';

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

function recorder(produce: (request: ActionRequest) => { qi: number; demonDelta: number }): {
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
    expect(result).toEqual({ tick: 1, steps: 0, gain: 0, demonDelta: 0, stall: null });
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
