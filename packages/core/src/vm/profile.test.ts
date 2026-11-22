import { describe, expect, it } from 'vitest';
import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import { loadContent } from '../content/loader';
import type { Content } from '../content/schema';
import { makeActionSink } from '../modifier/settle';
import { BACKLASH_LINE } from '../demon/rules';
import { Qi } from '../number/bignum';
import { BASE_BUDGET, TICKS_PER_SEC } from '../types';
import type { Op } from '../vm/program';
import { Vm } from '../vm/interpreter';
import { tickProfile } from './profile';

// 真表 + 逐条照抄 VM 口径的静态展开：这一模块存在的理由是「HUD 每秒那个数别再自己数块数了」，
// 而方向性（真编译器产出的 IR 也走同一份展开）钉在 packages/blocks/src/profile.test.ts —— core 不许依赖 blocks。
const CONTENT: Content = loadContent({ actions: actionsJson, realms: realmsJson });

const BREATH: Op = { op: 'ACTION', actionId: 'breath' };
const CALM: Op = { op: 'ACTION', actionId: 'calm' };
const HALT: Op = { op: 'HALT' };
const LOOP = (end: number, count: number): Op => ({ op: 'LOOP_BEGIN', end, count });
const LOOP_END = (begin: number): Op => ({ op: 'LOOP_END', begin });

const profileOf = (code: readonly Op[], budget = BASE_BUDGET) => tickProfile([code], budget);
const kinds = (code: readonly Op[], budget = BASE_BUDGET): readonly string[] => Array.from(profileOf(code, budget).kinds);
const depths = (code: readonly Op[], budget = BASE_BUDGET): readonly number[] => Array.from(profileOf(code, budget).depths);

describe('tickProfile：一 tick 真实执行序列（循环展开 + 散块）', () => {
  it('①「循环 3 次吐纳」是 3 个动作，不是工具箱里那 1 块积木', () => {
    expect(kinds([LOOP(2, 3), BREATH, LOOP_END(0), HALT])).toEqual(['breath', 'breath', 'breath']);
    expect(depths([LOOP(2, 3), BREATH, LOOP_END(0), HALT])).toEqual([1, 1, 1]);
  });

  it('① 嵌套循环按字面次数展开，深度取栈最大值', () => {
    const code: readonly Op[] = [LOOP(4, 2), LOOP(2, 3), BREATH, LOOP_END(0), LOOP_END(4), HALT];
    expect(kinds(code)).toHaveLength(6);
    // 外 2 × 内 3 = 6 次，每次真站在两层里头：depth 全 2，与 VM 观测到的 loopDepth 逐一对齐。
    expect(depths(code)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(profileOf(code).loopDepthMax).toBe(2);
    // 步数是这条唯一知道不等的地方：VM 每轮重入内层都要给 LOOP_BEGIN 计一步（18），
    // 展开器只走一遍（14）。差的 4 步全是控制流、没有动作，所以产出与心魔仍逐位相同；
    // 95% 闸门（pending.ts）真把这条程序摆上去时会偏保守，这是批次 2 已接受的口径。
    expect(profileOf(code).steps).toBe(14);
  });

  it('② 动作槽 k 序 = 执行序：循环 3 次后再接一块散吐纳，第 4 槽仍按第 4 次递减', () => {
    const code = [LOOP(2, 3), BREATH, LOOP_END(0), BREATH, HALT];
    const executed = kinds(code);
    expect(executed).toEqual(['breath', 'breath', 'breath', 'breath']);
    // 边际递减读的是 k（下标 + 1），不是积木块数：写死块数就是这次要修的病。
    const actionMult = (k: number): number => 1 / (1 + 0.25 * (k - 1));
    expect(executed.map((_, index) => actionMult(index + 1))).toEqual([1, 0.8, 0.6666666666666666, 0.5714285714285714]);
  });

  it('③ 多程序合并且顺序照 VM：programs[0] 的循环块全展开，才轮到 programs[1]', () => {
    const merged = tickProfile([[LOOP(2, 2), BREATH, LOOP_END(0), HALT], [CALM, HALT]], BASE_BUDGET);
    expect(Array.from(merged.kinds)).toEqual(['breath', 'breath', 'calm']);
    expect(Array.from(merged.depths)).toEqual([1, 1, 0]);
  });

  it('③ 预算是每 tick 总池：前一程序吃掉的步数，后一程序拿不到', () => {
    // 池只够 6 步：第一条程序（BEGIN 1 + 2×(ACTION+回边) 4 + HALT 1 = 6 步）跑完，
    // 第二条的吐纳排在预算之后 → 本 tick 轮不到。池是跨程序串下去的总池，不是每条程序各一份。
    const tight = tickProfile([[LOOP(2, 2), BREATH, LOOP_END(0), HALT], [BREATH, HALT]], 6);
    expect(Array.from(tight.kinds)).toEqual(['breath', 'breath']);
    expect(tight.truncated).toBe(true);
  });

  it('④ 超出预算就截断：展开出的动作数受池收口，不会凭空多出预算外的产出', () => {
    const code = [...Array.from({ length: 300 }, () => BREATH), HALT];
    expect(profileOf(code, 50).kinds).toHaveLength(50);
    expect(profileOf(code, 50).truncated).toBe(true);
    expect(profileOf(code, 50).steps).toBe(50);
    // 同一条程序在宽池下才给全 300 个：截断是预算决定的，不是实现漏了循环。
    expect(profileOf(code, BASE_BUDGET).kinds).toHaveLength(BASE_BUDGET);
  });

  it('count 为 0 的循环整个不执行（契约 §4.2，与 VM 同一支）', () => {
    expect(kinds([LOOP(2, 0), BREATH, LOOP_END(0), BREATH, HALT])).toEqual(['breath']);
  });

  it('「如果」按不成立估：走 else 那一支，则分支里的动作一个不算', () => {
    const code: readonly Op[] = [{ op: 'LOAD', key: 'demon' }, { op: 'PUSH', value: 0.5 }, { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 6 }, CALM, { op: 'JMP', target: 9 }, LOOP(8, 3), BREATH, LOOP_END(6), HALT];
    expect(kinds(code)).toEqual(['breath', 'breath', 'breath']);
  });
});

describe('tickProfile ↔ 真 VM 心魔逐位对齐（换的是计数口径，不是心魔公式）', () => {
  const CASES: readonly { readonly name: string; readonly code: readonly Op[]; readonly realmIndex: number; readonly ticks: number }[] = [
    { name: '循环 3 次吐纳', code: [LOOP(2, 3), BREATH, LOOP_END(0), HALT], realmIndex: 0, ticks: 30 * TICKS_PER_SEC },
    { name: '循环 + 散块混排', code: [LOOP(2, 3), BREATH, LOOP_END(0), BREATH, HALT], realmIndex: 0, ticks: 40 * TICKS_PER_SEC },
    { name: '嵌套循环（深度加成）', code: [LOOP(4, 2), LOOP(2, 3), BREATH, LOOP_END(0), LOOP_END(4), HALT], realmIndex: 1, ticks: 20 * TICKS_PER_SEC },
    { name: '只有调息的循环（负增长夹到 0）', code: [LOOP(2, 4), CALM, LOOP_END(0), HALT], realmIndex: 0, ticks: 60 * TICKS_PER_SEC },
  ];

  it.each(CASES)('$name：按 kinds/depths 走同一 sink 重放 = VM 的 demon', ({ code, realmIndex, ticks }) => {
    const sink = makeActionSink({ content: CONTENT, realmIndex });
    const vm = new Vm({ content: CONTENT, sink, vars: () => ({ qi: 0, rate: 0, demon: 0, realm: 0, budget: BASE_BUDGET }) });
    vm.installUnchecked([{ id: 'p0', code }]);
    let demon = Qi.zero;
    for (let tick = 0; tick < ticks; tick += 1) {
      const result = vm.tick();
      // 夹 0..1 是宿主那一头做的（runtime.ts 的心魔夹紧），重放要照同一条。
      demon = Math.min(BACKLASH_LINE, Math.max(0, demon + result.demonDelta));
    }

    const profile = tickProfile([code], BASE_BUDGET);
    const replay = makeActionSink({ content: CONTENT, realmIndex });
    let projected = Qi.zero;
    for (let tick = 0; tick < ticks; tick += 1) {
      let delta = Qi.zero;
      for (let index = 0; index < profile.kinds.length; index += 1) {
        delta = Qi.add(delta, replay.execute({ actionId: profile.kinds[index] ?? '', k: index + 1, pc: 0, loopDepth: profile.depths[index] ?? 0 }).demonDelta);
      }
      projected = Math.min(BACKLASH_LINE, Math.max(0, projected + delta));
    }
    expect(projected).toBe(demon);
  });

  it('VM 的 tick().profile 与直接调 tickProfile 同源（HUD 读的那份就是算的那份）', () => {
    const code = [LOOP(2, 3), BREATH, LOOP_END(0), CALM, HALT];
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0 });
    const vm = new Vm({ content: CONTENT, sink, vars: () => ({ qi: 0, rate: 0, demon: 0, realm: 0, budget: BASE_BUDGET }) });
    vm.installUnchecked([{ id: 'p0', code }]);
    const direct = tickProfile([code], BASE_BUDGET);
    for (let tick = 0; tick < 5; tick += 1) {
      const fromVm = vm.tick().profile;
      expect(Array.from(fromVm?.kinds ?? [])).toEqual(Array.from(direct.kinds));
      expect(Array.from(fromVm?.depths ?? [])).toEqual(Array.from(direct.depths));
      expect(fromVm?.loopDepthMax).toBe(direct.loopDepthMax);
      expect(fromVm?.truncated).toBe(direct.truncated);
    }
  });
});
