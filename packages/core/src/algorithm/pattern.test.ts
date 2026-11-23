import { describe, expect, it } from 'vitest';
import { BACKLASH_LINE, patternsOf, shapeOf, type Op } from '@gongfa/core';

// 手搓 IR 的判定测试：不依赖编译器，证明 shapeOf / patternsOf 的纯函数语义自洽。
// 真编译器产物 ↔ 图案的对应关系在 packages/blocks/src/pattern.test.ts 里证。

const breath: Op = { op: 'ACTION', actionId: 'breath' };
const calm: Op = { op: 'ACTION', actionId: 'calm' };
const halt: Op = { op: 'HALT' };

function loop(count: number, body: readonly Op[]): readonly Op[] {
  const begin: Op = { op: 'LOOP_BEGIN', end: 0, count };
  const end: Op = { op: 'LOOP_END', begin: 0 };
  const code = [begin, ...body, end];
  code[0] = { op: 'LOOP_BEGIN', end: code.length, count };
  code[code.length - 1] = { op: 'LOOP_END', begin: 0 };
  return code;
}

function branch(condition: { key: 'qi' | 'rate' | 'demon' | 'realm' | 'budget'; cmp: '<' | '>' | '=='; value: number }, then: readonly Op[], otherwise: readonly Op[] = []): readonly Op[] {
  const load: Op = { op: 'LOAD', key: condition.key };
  const push: Op = { op: 'PUSH', value: condition.value };
  const cmp: Op = { op: 'CMP', arg: condition.cmp };
  const jmpFalse: Op = { op: 'JMP_IF_FALSE', target: 0 };
  const code: Op[] = [load, push, cmp, jmpFalse, ...then];
  if (otherwise.length > 0) {
    const jmp: Op = { op: 'JMP', target: 0 };
    code.push(jmp);
    code[3] = { op: 'JMP_IF_FALSE', target: code.length - 1 };
    code.push(...otherwise);
    code[code.length - 1] = { op: 'JMP', target: code.length };
  } else {
    code[3] = { op: 'JMP_IF_FALSE', target: code.length };
  }
  return code;
}

function code(...ops: readonly Op[]): readonly Op[] {
  return [...ops, halt];
}

describe('shapeOf', () => {
  it('空程序：无动作、无循环、无分支', () => {
    const shape = shapeOf(code(), []);
    expect(shape.actions).toEqual([]);
    expect(shape.loops).toEqual([]);
    expect(shape.branches).toEqual([]);
  });

  it('单块吐纳：actions = [breath]', () => {
    const shape = shapeOf(code(breath), []);
    expect(shape.actions).toEqual(['breath']);
  });

  it('循环 3 次吐纳：loops[0].actionIds = [breath]（结构快照不展开循环）', () => {
    const shape = shapeOf(loop(3, [breath]), []);
    expect(shape.loops).toHaveLength(1);
    expect(shape.loops[0]?.actionIds).toEqual(['breath']);
    expect(shape.loops[0]?.count).toBe(3);
  });

  it('嵌套循环：两个循环区间都被记录', () => {
    const inner = loop(2, [breath]);
    const outer = loop(3, inner);
    const shape = shapeOf(outer, []);
    expect(shape.loops).toHaveLength(2);
    const depths = shape.loops.map((l) => l.depth).sort();
    expect(depths[0]).toBe(0);
    expect(depths[1]).toBe(1);
  });
});

describe('patternsOf — linear', () => {
  it('单块吐纳 → linear', () => {
    expect(patternsOf(shapeOf(code(breath), []))).toEqual(['linear']);
  });

  it('两块吐纳 → 空（边际递减的课还没上）', () => {
    expect(patternsOf(shapeOf(code(breath, breath), []))).toEqual([]);
  });

  it('循环里一块吐纳 → 不是 linear（有控制流）', () => {
    expect(patternsOf(shapeOf(loop(1, [breath]), []))).not.toContain('linear');
  });
});

describe('patternsOf — loop', () => {
  it('循环 3 次吐纳 → loop', () => {
    expect(patternsOf(shapeOf(loop(3, [breath]), []))).toContain('loop');
  });

  it('循环 1 次吐纳 → loop（单次也算「周天循环」结构）', () => {
    expect(patternsOf(shapeOf(loop(1, [breath]), []))).toContain('loop');
  });

  it('循环里套分支 → 不是 loop（hasBranch = true）', () => {
    const body = branch({ key: 'demon', cmp: '>', value: 0.5 }, [calm]);
    expect(patternsOf(shapeOf(loop(2, body), []))).not.toContain('loop');
  });

  it('循环里放调息 → 不是 loop（actionIds 不全是 breath）', () => {
    expect(patternsOf(shapeOf(loop(2, [calm]), []))).not.toContain('loop');
  });
});

describe('patternsOf — feedback', () => {
  it('如果 心魔 > 0.5 则 调息 → feedback', () => {
    const shape = shapeOf(branch({ key: 'demon', cmp: '>', value: 0.5 }, [calm]), []);
    expect(patternsOf(shape)).toContain('feedback');
  });

  it('如果 心魔 > 1（= BACKLASH_LINE）→ 不是 feedback（条件永远不成立）', () => {
    const shape = shapeOf(branch({ key: 'demon', cmp: '>', value: BACKLASH_LINE }, [calm]), []);
    expect(patternsOf(shape)).not.toContain('feedback');
  });

  it('如果 心魔 < 0.5 则 调息 → 不是 feedback（方向反了）', () => {
    const shape = shapeOf(branch({ key: 'demon', cmp: '<', value: 0.5 }, [calm]), []);
    expect(patternsOf(shape)).not.toContain('feedback');
  });

  it('如果 心魔 > 0.5 则 吐纳 → 不是 feedback（则分支里没有调息）', () => {
    const shape = shapeOf(branch({ key: 'demon', cmp: '>', value: 0.5 }, [breath]), []);
    expect(patternsOf(shape)).not.toContain('feedback');
  });

  it('如果 存量 > 100 则 调息 → 不是 feedback（左值不是心魔）', () => {
    const shape = shapeOf(branch({ key: 'qi', cmp: '>', value: 100 }, [calm]), []);
    expect(patternsOf(shape)).not.toContain('feedback');
  });

  it('如果 心魔 > 0 则 调息 → 不是 feedback（阈值必须 > 0）', () => {
    const shape = shapeOf(branch({ key: 'demon', cmp: '>', value: 0 }, [calm]), []);
    expect(patternsOf(shape)).not.toContain('feedback');
  });
});

describe('patternsOf — cache', () => {
  it('循环 2 次吐纳 + 装备玉简 → cache', () => {
    const shape = shapeOf(loop(2, [breath]), ['jade']);
    expect(patternsOf(shape)).toContain('cache');
  });

  it('循环 1 次 + 装备玉简 → 不是 cache（单次循环没有「第二次命中」）', () => {
    const shape = shapeOf(loop(1, [breath]), ['jade']);
    expect(patternsOf(shape)).not.toContain('cache');
  });

  it('循环 2 次 + 无装备 → 不是 cache', () => {
    const shape = shapeOf(loop(2, [breath]), []);
    expect(patternsOf(shape)).not.toContain('cache');
  });

  it('循环 2 次 + 装备算盘 → 不是 cache（必须是玉简）', () => {
    const shape = shapeOf(loop(2, [breath]), ['abacus']);
    expect(patternsOf(shape)).not.toContain('cache');
  });

  it('循环 2 次空体 + 装备玉简 → 不是 cache（循环体必须有动作）', () => {
    const shape = shapeOf(loop(2, []), ['jade']);
    expect(patternsOf(shape)).not.toContain('cache');
  });
});

describe('patternsOf — 组合', () => {
  it('循环里套清心诀 → feedback（loop 不命中，因为 hasBranch = true）', () => {
    // 手搓 IR：循环 2 次，体内有分支（JMP_IF_FALSE 在循环区间内）。
    const code: Op[] = [
      { op: 'LOOP_BEGIN', end: 7, count: 2 },
      { op: 'LOAD', key: 'demon' },
      { op: 'PUSH', value: 0.5 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 6 },
      { op: 'ACTION', actionId: 'calm' },
      { op: 'LOOP_END', begin: 0 },
      { op: 'HALT' },
    ];
    const shape = shapeOf(code, []);
    const patterns = patternsOf(shape);
    expect(patterns).toContain('feedback');
    expect(patterns).not.toContain('loop');
  });

  it('循环 2 次吐纳 + 玉简 + 清心诀 → cache ∩ feedback（loop 不命中）', () => {
    const code: Op[] = [
      { op: 'LOOP_BEGIN', end: 10, count: 2 },
      { op: 'ACTION', actionId: 'breath' },
      { op: 'LOAD', key: 'demon' },
      { op: 'PUSH', value: 0.5 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 9 },
      { op: 'ACTION', actionId: 'calm' },
      { op: 'JMP', target: 10 },
      { op: 'ACTION', actionId: 'breath' },
      { op: 'LOOP_END', begin: 0 },
      { op: 'HALT' },
    ];
    const shape = shapeOf(code, ['jade']);
    const patterns = patternsOf(shape);
    expect(patterns).not.toContain('loop');
    expect(patterns).toContain('cache');
    expect(patterns).toContain('feedback');
  });

  it('循环内 BREAK → break 图案', () => {
    const code: Op[] = [
      { op: 'LOOP_BEGIN', end: 4, count: 3 },
      { op: 'ACTION', actionId: 'breath' },
      { op: 'BREAK' },
      { op: 'LOOP_END', begin: 0 },
      { op: 'HALT' },
    ];
    const shape = shapeOf(code, []);
    const patterns = patternsOf(shape);
    expect(patterns).toContain('break');
    expect(patterns).toContain('loop'); // loop 也命中（循环体全是吐纳，没有分支）
  });

  it('WHILE 循环 → while 图案', () => {
    const code: Op[] = [
      { op: 'WHILE_BEGIN' },
      { op: 'LOAD', key: 'budget' },
      { op: 'PUSH', value: 0 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 6 },
      { op: 'ACTION', actionId: 'breath' },
      { op: 'WHILE_END', begin: 1 },
      { op: 'WHILE_EXIT' },
      { op: 'HALT' },
    ];
    const shape = shapeOf(code, []);
    const patterns = patternsOf(shape);
    expect(patterns).toContain('while');
  });

  it('WHILE 循环内 BREAK → while ∩ break', () => {
    const code: Op[] = [
      { op: 'WHILE_BEGIN' },
      { op: 'LOAD', key: 'budget' },
      { op: 'PUSH', value: 0 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 7 },
      { op: 'ACTION', actionId: 'breath' },
      { op: 'BREAK' },
      { op: 'WHILE_END', begin: 1 },
      { op: 'WHILE_EXIT' },
      { op: 'HALT' },
    ];
    const shape = shapeOf(code, []);
    const patterns = patternsOf(shape);
    expect(patterns).toContain('while');
    expect(patterns).toContain('break');
  });

  // 评审实测的误判：while 的 endPc 曾是 -1，于是 while 体内任何 JMP（普通 if-else 尾部、
  // continue）都被判成「跳出循环」。这条钉住"没有 BREAK 就不算 break"。
  it('重复直到 + 继续：不该被判成「见好就收」', () => {
    const code: Op[] = [
      { op: 'WHILE_BEGIN' },
      { op: 'LOAD', key: 'demon' },
      { op: 'PUSH', value: 0.7 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 8 },
      { op: 'ACTION', actionId: 'breath' },
      { op: 'JMP', target: 1 },
      { op: 'WHILE_END', begin: 1 },
      { op: 'WHILE_EXIT' },
      { op: 'HALT' },
    ];
    const patterns = patternsOf(shapeOf(code, []));
    expect(patterns).toContain('while');
    expect(patterns).not.toContain('break');
  });

  it('重复直到 + 中断：仍然判成「见好就收」', () => {
    const code: Op[] = [
      { op: 'WHILE_BEGIN' },
      { op: 'LOAD', key: 'demon' },
      { op: 'PUSH', value: 0.7 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 9 },
      { op: 'ACTION', actionId: 'breath' },
      { op: 'BREAK' },
      { op: 'WHILE_END', begin: 1 },
      { op: 'WHILE_EXIT' },
      { op: 'HALT' },
    ];
    const patterns = patternsOf(shapeOf(code, []));
    expect(patterns).toContain('while');
    expect(patterns).toContain('break');
  });
});
