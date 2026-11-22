import { describe, expect, it } from 'vitest';
import {
  BASE_BUDGET,
  BACKLASH_LINE,
  Qi,
  Vm,
  loadContent,
  makeActionSink,
  previewCurve,
  tickProfile,
  type Program,
} from '@gongfa/core';
import actionsJson from '../../../content/actions.json';
import realmsJson from '../../../content/realms.json';
import { compileWorkspace, type SerializedBlock, type WorkspaceJson } from './compiler';

// 批次 2 补充裁定的方向性：core/src/vm/profile.test.ts 用手搓 IR 证明展开器自洽，
// 这一份证明「玩家拖出来的嵌套循环」展开后的执行序与层数，与真 VM 逐步观测到的逐一对齐。
// 不对齐就没有「一份算法」可言，HUD 与曲线会各说各话。
const CONTENT = loadContent({ actions: actionsJson, realms: realmsJson });

function chain(blocks: readonly SerializedBlock[]): SerializedBlock | undefined {
  const [first, ...rest] = blocks as [SerializedBlock | undefined, ...SerializedBlock[]];
  if (first === undefined) return undefined;
  const next = chain(rest);
  return next === undefined ? first : { ...first, next: { block: next } };
}

function hat(...blocks: SerializedBlock[]): WorkspaceJson {
  const body = chain(blocks);
  if (body === undefined) throw new Error('「每 tick」凹槽是空的，这份夹具没有意义');
  return { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h', x: 32, y: 32, inputs: { BODY: { block: body } } }] } };
}

const breath: SerializedBlock = { type: 'breath', id: 'b1' };
const repeat = (id: string, times: number, body: SerializedBlock): SerializedBlock => ({
  type: 'gongfa_repeat',
  id,
  fields: { NUM: times },
  inputs: { DO: { block: body } },
});

function compiled(workspace: WorkspaceJson): Program {
  const result = compileWorkspace(workspace);
  if (result.program === null) throw new Error(`编译失败：${result.errors.join(' ｜ ')}`);
  return result.program;
}

// 真 VM 观测：给 sink 套一层记录，把每次 ACTION 的 loopDepth 抄下来（runtime.ts 读的就是这一个值）。
function vmObservation(code: Program['code']): { readonly depths: readonly number[]; readonly steps: number; readonly demon: Qi } {
  const sink = makeActionSink({ content: CONTENT, realmIndex: 0 });
  const depths: number[] = [];
  const vm = new Vm({
    content: CONTENT,
    sink: {
      execute: (request) => {
        depths.push(request.loopDepth);
        return sink.execute(request);
      },
    },
    vars: () => ({ qi: 0, rate: 0, demon: 0, realm: 0, budget: BASE_BUDGET }),
  });
  vm.installUnchecked([{ id: 'p0', code }]);
  const result = vm.tick();
  return { depths, steps: result.steps, demon: result.demonDelta };
}

describe('真编译器产物 ↔ tickProfile（一份展开算法）', () => {
  it('循环 3 次吐纳：展开成 3 个动作、每层 1，而不是工具箱里那 1 块积木', () => {
    const program = compiled(hat(repeat('r1', 3, breath)));
    const profile = tickProfile([program.code], BASE_BUDGET);
    expect(Array.from(profile.kinds)).toEqual(['breath', 'breath', 'breath']);
    expect(Array.from(profile.depths)).toEqual([1, 1, 1]);
    expect(profile.loopDepthMax).toBe(1);
  });

  it('嵌套 2×3：展开出的 kinds/depths 与 VM 逐步观测的 loopDepth 逐一对齐', () => {
    const program = compiled(hat(repeat('outer', 2, repeat('inner', 3, breath))));
    const observed = vmObservation(program.code);
    const profile = tickProfile([program.code], BASE_BUDGET);
    expect(observed.depths).toHaveLength(6);
    expect(Array.from(profile.kinds)).toHaveLength(6);
    expect(Array.from(profile.depths)).toEqual(Array.from(observed.depths));
    expect(profile.loopDepthMax).toBe(Math.max(...observed.depths));
  });

  it('嵌套循环的心魔：按 kinds/depths 重放同一支 sink = VM 本 tick 的 demonDelta（展开器不许把加成算两遍）', () => {
    const program = compiled(hat(repeat('outer', 2, repeat('inner', 3, breath))));
    const observed = vmObservation(program.code);
    const profile = tickProfile([program.code], BASE_BUDGET);
    const sink = makeActionSink({ content: CONTENT, realmIndex: 0 });
    let replayed = Qi.zero;
    for (let index = 0; index < profile.kinds.length; index += 1) {
      const outcome = sink.execute({
        actionId: profile.kinds[index] ?? '',
        k: index + 1,
        pc: 0,
        loopDepth: profile.depths[index] ?? 0,
      });
      replayed = Qi.add(replayed, Qi.of(outcome.demonDelta));
    }
    expect(replayed).toBe(observed.demon);
  });

  it('曲线的心魔预测读同一份展开：嵌套循环 6 次 = 每 tick 0.0006，不是 0.0003 也不是 0.0009', () => {
    const program = compiled(hat(repeat('outer', 2, repeat('inner', 3, breath))));
    const preview = previewCurve({ content: CONTENT, realmIndex: 0, code: program.code });
    // 600 tick × 0.0006 = 0.36：离火线（BACKLASH_LINE = 1）还远，所以 60 秒不截断。
    expect(preview.demonPoints[59]).toBeCloseTo(0.36, 12);
    expect(preview.backlashAtSec).toBeNull();
    expect(BACKLASH_LINE).toBe(1);
  });
});
