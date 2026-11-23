import { describe, expect, it } from 'vitest';
import { linearizeProgram } from '@gongfa/core';
import { compileWorkspace } from './compiler';
import { suggestRewrite } from './optimizer';
import type { WorkspaceJson } from './definitions';

const breath = (id: string): { block: Record<string, unknown> } => ({ block: { type: 'breath', id } });

/** 直列 n 块吐纳。 */
function straight(n: number): WorkspaceJson {
  let node: Record<string, unknown> | undefined;
  for (let i = n; i >= 1; i -= 1) {
    node = { type: 'breath', id: `b${i}`, ...(node ? { next: { block: node } } : {}) };
  }
  return {
    blocks: {
      languageVersion: 0,
      blocks: [{ type: 'tick_hat', id: 'h', x: 32, y: 32, inputs: { BODY: { block: node } } }],
    },
  } as unknown as WorkspaceJson;
}

function programOf(json: WorkspaceJson) {
  const compiled = compileWorkspace(json);
  expect(compiled.ok, compiled.errors.join('；')).toBe(true);
  return compiled.program!;
}

describe('炼器炉：直列 N 块 → 循环 N 次', () => {
  it('6 块直列会被建议改写', () => {
    const suggestion = suggestRewrite(straight(6));
    expect(suggestion).not.toBeNull();
    expect(suggestion!.runLength).toBe(6);
    expect(suggestion!.irAfter).toBeLessThan(suggestion!.irBefore);
  });

  it('改写前后产出序列完全一致；但循环深度 0 → 1，心魔增速变快', () => {
    const before = programOf(straight(5));
    const suggestion = suggestRewrite(straight(5))!;
    const after = programOf(suggestion.after);
    const a = linearizeProgram(before.code, 200);
    const b = linearizeProgram(after.code, 200);
    // 产出等价：同样的 actionId 序列、同样的 k 计数
    expect(b.kinds).toEqual(a.kinds);
    // 代价：深度全变 1 —— 吐纳的心魔增长按 (1 + 0.5×depth) 计，会 ×1.5
    expect(a.depths.every((d) => d === 0)).toBe(true);
    expect(b.depths.every((d) => d === 1)).toBe(true);
    expect(suggestion.demonFactor).toBe(1.5);
  });

  it('代价可测量：IR 变短，但每 tick 步数变多', () => {
    const suggestion = suggestRewrite(straight(5))!;
    const a = linearizeProgram(programOf(straight(5)).code, 200);
    const b = linearizeProgram(programOf(suggestion.after).code, 200);
    expect(b.steps).toBeGreaterThan(a.steps);
  });

  it('只有 2 块时不建议（收益抵不过可读性）', () => {
    expect(suggestRewrite(straight(2))).toBeNull();
  });

  it('没有动作时不建议', () => {
    const empty: WorkspaceJson = {
      blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h', x: 32, y: 32 }] },
    } as unknown as WorkspaceJson;
    expect(suggestRewrite(empty)).toBeNull();
  });
});
