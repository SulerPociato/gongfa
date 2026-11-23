import { describe, expect, it } from 'vitest';
import { patternsOf, shapeOf } from '@gongfa/core';
import { compileWorkspace, type SerializedBlock, type WorkspaceJson } from './compiler';

// 真编译器产物 ↔ 图案识别：证明 shapeOf / patternsOf 对玩家拖出来的积木序列判据正确。
// 与 core/src/algorithm/pattern.test.ts 的手搓 IR 互补：那里证纯函数自洽，这里证与编译器对齐。

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
const calm: SerializedBlock = { type: 'calm', id: 'c1' };
const repeat = (id: string, times: number, body: SerializedBlock): SerializedBlock => ({
  type: 'gongfa_repeat',
  id,
  fields: { NUM: times },
  inputs: { DO: { block: body } },
});
const compare = (left: string, op: string, threshold: number): SerializedBlock => ({
  type: 'gongfa_compare',
  id: `cmp_${left}_${op}_${threshold}`,
  fields: { LEFT: left, OP: op, THRESHOLD: threshold },
});
const ifBlock = (condition: SerializedBlock, then: SerializedBlock, otherwise?: SerializedBlock): SerializedBlock => ({
  type: 'gongfa_if',
  id: `if_${condition.id}`,
  inputs: {
    CONDITION: { block: condition },
    IF: { block: then },
    ...(otherwise === undefined ? {} : { ELSE: { block: otherwise } }),
  },
});

function compiled(workspace: WorkspaceJson): readonly import('@gongfa/core').Op[] {
  const result = compileWorkspace(workspace);
  if (result.program === null) throw new Error(`编译失败：${result.errors.join(' ｜ ')}`);
  return result.program.code;
}

describe('真编译器产物 ↔ patternsOf（一份识别算法）', () => {
  it('单块吐纳 → linear', () => {
    const code = compiled(hat(breath));
    expect(patternsOf(shapeOf(code, []))).toEqual(['linear']);
  });

  it('两块吐纳 → 空（边际递减的课还没上）', () => {
    const code = compiled(hat(breath, breath));
    expect(patternsOf(shapeOf(code, []))).toEqual([]);
  });

  it('循环 3 次吐纳 → loop', () => {
    const code = compiled(hat(repeat('r1', 3, breath)));
    expect(patternsOf(shapeOf(code, []))).toContain('loop');
  });

  it('循环 1 次吐纳 → loop（单次也算「周天循环」结构）', () => {
    const code = compiled(hat(repeat('r1', 1, breath)));
    expect(patternsOf(shapeOf(code, []))).toContain('loop');
  });

  it('循环里套调息 → 不是 loop（actionIds 不全是 breath）', () => {
    const code = compiled(hat(repeat('r1', 2, calm)));
    expect(patternsOf(shapeOf(code, []))).not.toContain('loop');
  });

  it('如果 心魔 > 0.5 则 调息 → feedback', () => {
    const code = compiled(hat(ifBlock(compare('demon', '>', 0.5), calm)));
    expect(patternsOf(shapeOf(code, []))).toContain('feedback');
  });

  it('如果 心魔 > 1（= BACKLASH_LINE）→ 不是 feedback（条件永远不成立）', () => {
    const code = compiled(hat(ifBlock(compare('demon', '>', 1), calm)));
    expect(patternsOf(shapeOf(code, []))).not.toContain('feedback');
  });

  it('如果 心魔 < 0.5 则 调息 → 不是 feedback（方向反了）', () => {
    const code = compiled(hat(ifBlock(compare('demon', '<', 0.5), calm)));
    expect(patternsOf(shapeOf(code, []))).not.toContain('feedback');
  });

  it('如果 心魔 > 0.5 则 吐纳 → 不是 feedback（则分支里没有调息）', () => {
    const code = compiled(hat(ifBlock(compare('demon', '>', 0.5), breath)));
    expect(patternsOf(shapeOf(code, []))).not.toContain('feedback');
  });

  it('循环 2 次吐纳 + 装备玉简 → cache', () => {
    const code = compiled(hat(repeat('r1', 2, breath)));
    expect(patternsOf(shapeOf(code, ['jade']))).toContain('cache');
  });

  it('循环 1 次 + 装备玉简 → 不是 cache（单次循环没有「第二次命中」）', () => {
    const code = compiled(hat(repeat('r1', 1, breath)));
    expect(patternsOf(shapeOf(code, ['jade']))).not.toContain('cache');
  });

  it('循环 2 次 + 无装备 → 不是 cache', () => {
    const code = compiled(hat(repeat('r1', 2, breath)));
    expect(patternsOf(shapeOf(code, []))).not.toContain('cache');
  });

  it('循环 2 次 + 装备算盘 → 不是 cache（必须是玉简）', () => {
    const code = compiled(hat(repeat('r1', 2, breath)));
    expect(patternsOf(shapeOf(code, ['abacus']))).not.toContain('cache');
  });

  it('循环里套清心诀 → feedback（loop 不命中，因为 hasBranch = true）', () => {
    const code = compiled(hat(repeat('r1', 2, ifBlock(compare('demon', '>', 0.5), calm))));
    const patterns = patternsOf(shapeOf(code, []));
    expect(patterns).toContain('feedback');
    expect(patterns).not.toContain('loop');
  });

  it('循环 2 次吐纳 + 玉简 + 清心诀 → cache ∩ feedback（loop 不命中）', () => {
    const code = compiled(hat(repeat('r1', 2, ifBlock(compare('demon', '>', 0.5), calm, breath))));
    const patterns = patternsOf(shapeOf(code, ['jade']));
    expect(patterns).not.toContain('loop');
    expect(patterns).toContain('cache');
    expect(patterns).toContain('feedback');
  });
});
