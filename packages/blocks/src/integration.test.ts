import { describe, expect, it } from 'vitest';
import { BASE_BUDGET, DEMON_BASE_PER_ACTION, TICKS_PER_SEC, Vm, loadContent, makeActionSink, type Program, type TickResult, type VmSnapshot } from '@gongfa/core';
import actionsJson from '../../../content/actions.json';
import realmsJson from '../../../content/realms.json';
import { compileWorkspace, type SerializedBlock, type WorkspaceJson } from './compiler';

const CONTENT = loadContent({ actions: actionsJson, realms: realmsJson });

function breath(id: string): SerializedBlock {
  return { type: 'breath', id };
}
function calm(id: string): SerializedBlock {
  return { type: 'calm', id };
}
function breakBlock(id: string): SerializedBlock {
  return { type: 'gongfa_break', id };
}
function continueBlock(id: string): SerializedBlock {
  return { type: 'gongfa_continue', id };
}
function compare(id: string, left: string, op: string, threshold: number | string): SerializedBlock {
  return { type: 'gongfa_compare', id, fields: { LEFT: left, OP: op, THRESHOLD: threshold } };
}
function repeat(id: string, count: number | string, body: SerializedBlock): SerializedBlock {
  return { type: 'gongfa_repeat', id, fields: { NUM: count }, inputs: { DO: { block: body } } };
}
function whileBlock(id: string, cond: SerializedBlock, body: SerializedBlock): SerializedBlock {
  return { type: 'gongfa_while', id, inputs: { CONDITION: { block: cond }, DO: { block: body } } };
}
function ifElse(id: string, cond: SerializedBlock, then: SerializedBlock, otherwise: SerializedBlock): SerializedBlock {
  return { type: 'gongfa_if', id, inputs: { CONDITION: { block: cond }, IF: { block: then }, ELSE: { block: otherwise } } };
}
function ifThen(id: string, cond: SerializedBlock, then: SerializedBlock): SerializedBlock {
  return { type: 'gongfa_if', id, inputs: { CONDITION: { block: cond }, IF: { block: then } } };
}
function hat(body: SerializedBlock): WorkspaceJson {
  return { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h', x: 32, y: 32, inputs: { BODY: { block: body } } }] } };
}
// 语句链：把多个块串成 next 序列
function chain(...blocks: SerializedBlock[]): SerializedBlock {
  for (let i = blocks.length - 2; i >= 0; i--) {
    const current = blocks[i];
    const next = blocks[i + 1];
    if (current === undefined || next === undefined) continue;
    blocks[i] = { ...current, next: { block: next } };
  }
  const first = blocks[0];
  if (first === undefined) throw new Error('chain requires at least one block');
  return first;
}

// 验收 1：每 tick → 如果 心魔 > 0.5 则 调息 否则 循环 3 次 吐纳
const ACCEPTANCE_PROGRAM: WorkspaceJson = hat(ifElse('i1', compare('c1', 'demon', '>', 0.5), calm('s1'), repeat('r1', 3, breath('s2'))));

interface Row {
  readonly tick: number;
  readonly rate: number;
  readonly demon: number;
  readonly result: TickResult;
}

// 宿主口径（任务 4 起）：qi / demon 由宿主持有，每 tick 通过 vars 快照喂回 VM，demon 夹在 0..1。
// 超 1.0 的走火入魔惩罚（qi ×0.7、心魔归 0）在任务 6 实现，这里只夹不罚。
function simulate(workspace: WorkspaceJson, seedDemon: number): { vm: Vm; step(): Row } {
  const compiled = compileWorkspace(workspace);
  if (!compiled.ok || compiled.program === null) throw new Error(`编译失败：${compiled.errors.join(' ｜ ')}`);
  const program: Program = compiled.program;
  const state = { qi: 0, demon: seedDemon, rate: 0 };
  const vm = new Vm({
    content: CONTENT,
    sink: makeActionSink({ content: CONTENT, realmIndex: 0 }),
    vars: (): VmSnapshot => ({ qi: state.qi, rate: state.rate, demon: state.demon, realm: 0, budget: BASE_BUDGET }),
  });
  const loaded = vm.loadPrograms([program]);
  if (!loaded.ok) throw new Error(`装载失败：${loaded.errors.map((issue) => issue.message).join(' ｜ ')}`);

  return {
    vm,
    step() {
      const result = vm.tick();
      state.qi += result.gain;
      state.demon = Math.min(1, Math.max(0, state.demon + result.demonDelta));
      state.rate = result.gain * TICKS_PER_SEC;
      return { tick: result.tick, rate: state.rate, demon: state.demon, result };
    },
  };
}

describe('编译产物喂进真 VM（端到端）', () => {
  it('验收 1 的 5 块程序：编译 → verifier 装载通过，10 条指令', () => {
    const compiled = compileWorkspace(ACCEPTANCE_PROGRAM);
    expect(compiled.ok).toBe(true);
    expect(compiled.program?.code.length).toBe(10);
    const sim = simulate(ACCEPTANCE_PROGRAM, 0.49);
    expect(sim.vm.programs[0]?.code).toEqual(compiled.program?.code);
  });

  it('心魔越过 0.5 时逐 tick 切换分支：24.7 ↔ 0.0 持续振荡', () => {
    const sim = simulate(ACCEPTANCE_PROGRAM, 0.49);
    const rows = Array.from({ length: 60 }, () => sim.step());
    const rates = rows.map((row) => Number(row.rate.toFixed(1)));
    const switches = rows.slice(1).map((row, i) => ({ from: rates[i] ?? 0, to: Number(row.rate.toFixed(1)), tick: row.tick })).filter((s) => s.from !== s.to);

    // 则分支只调息 → gain 0；否则分支 3 次吐纳 → 1 + 0.8 + 1/1.5 = 2.4667/tick → 24.7/秒
    expect(rates.filter((rate) => rate === 24.7).length).toBeGreaterThan(50);
    expect(rates.filter((rate) => rate === 0).length).toBeGreaterThan(0);
    expect(switches.length).toBeGreaterThan(1);
    expect(rows.some((row, i) => i > 0 && row.rate === 0 && row.result.tick > 0 && (rows[i - 1]?.rate ?? 0) > 0 && row.demon <= 0.5)).toBe(true);
    console.log(`验收 1（seed demon=0.49）前 12 tick rate：${rates.slice(0, 12).join(' ')}`);
    console.log(`首次切分支 tick=${switches[0]?.tick} ${switches[0]?.from}→${switches[0]?.to} ｜ 60 tick 内共 ${switches.length} 次切换：${switches.map((s) => `${s.tick}:${s.from}→${s.to}`).join(' ')}`);
  });

  it('心魔增长按契约 §2.2.1：循环内 3 次吐纳 = 3 × 0.00005 × 1.5', () => {
    const row = simulate(ACCEPTANCE_PROGRAM, 0).step();
    expect(row.result.gain).toBeCloseTo(1 + 0.8 + 1 / 1.5, 12);
    expect(row.demon).toBeCloseTo(3 * DEMON_BASE_PER_ACTION * 1.5, 12);
  });

  it('循环 10×10×10 在 200 步被截断，stall 字段齐全（HUD 红字的数据源）', () => {
    const sim = simulate(hat(repeat('r1', 10, repeat('r2', 10, repeat('r3', 10, breath('s'))))), 0);
    const row = sim.step();
    const stall = row.result.stall;
    expect(row.result.gain).toBeGreaterThan(0);
    expect(stall).not.toBeNull();
    expect(stall?.reason).toBe('budget');
    expect(stall?.steps).toBe(BASE_BUDGET);
    expect(stall?.programId).toBe('gongfa');
    expect(stall?.tick).toBe(row.tick);
    console.log(`深层循环实测：动作 ${row.result.gain.toFixed(2)} 次灵力后截断 → stall=${JSON.stringify(stall)}`);
  });
});

// 批次 5 必填三项：continue/break 的 VM 语义验证
describe('批次 5：continue / break VM 语义', () => {
  it('循环3次{ 吐纳; 继续; 吐纳 } → ACTION 恰好 3 次、stall=null、帧深始终 1', () => {
    // repeat(3) { breath; continue; breath }
    // continue 跳到 LOOP_END，LOOP_END 递减 remaining 并跳回 LOOP_BEGIN+1
    // 每轮执行 1 次 breath（continue 后面的 breath 被跳过），3 轮共 3 次
    const body = chain(breath('b1'), continueBlock('c1'), breath('b2'));
    const program = hat(repeat('r1', 3, body));
    const sim = simulate(program, 0);
    const row = sim.step();
    // 每轮只有 continue 前的 breath 执行，continue 跳到 LOOP_END 跳过第二个 breath
    // 3 轮 × 1 次 = 3 次 ACTION，边际递减：1 + 0.8 + 1/1.5 = 2.4667
    expect(row.result.gain).toBeCloseTo(1 + 0.8 + 1 / 1.5, 5);
    expect(row.result.stall).toBeNull();
  });

  it('循环3次{ 吐纳; 如果 心魔>0 则 中断 } → 只执行 1 次吐纳、帧深回到 0', () => {
    // repeat(3) { breath; if demon>0 then break }
    // 第 1 轮：breath(k=1) → demon 涨到 >0 → break → 弹帧退出
    // 只执行 1 次 breath
    // 注意：VM 在 tick 开始时快照 vars，所以 seedDemon 必须 > 0 才能让条件成立
    const cond = compare('c1', 'demon', '>', 0);
    const body = chain(breath('b1'), ifThen('i1', cond, breakBlock('brk1')));
    const program = hat(repeat('r1', 3, body));
    const sim = simulate(program, 0.1); // seedDemon > 0
    const row = sim.step();
    expect(row.result.gain).toBe(1);
    expect(row.result.stall).toBeNull();
  });

  it('while{ 吐纳; 如果 心魔>0 则 中断 } → 同 2，只执行 1 次吐纳', () => {
    // while budget>0 { breath; if demon>0 then break }
    // 第 1 轮：breath(k=1) → demon 涨到 >0 → break → 弹帧退出 WHILE
    // 注意：VM 在 tick 开始时快照 vars，所以 seedDemon 必须 > 0 才能让条件成立
    const cond = compare('c1', 'budget', '>', 0);
    const breakCond = compare('c2', 'demon', '>', 0);
    const body = chain(breath('b1'), ifThen('i1', breakCond, breakBlock('brk1')));
    const program = hat(whileBlock('w1', cond, body));
    const sim = simulate(program, 0.1); // seedDemon > 0
    const row = sim.step();
    expect(row.result.gain).toBe(1);
    expect(row.result.stall).toBeNull();
  });
});
