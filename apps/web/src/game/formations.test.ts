import { describe, expect, it } from 'vitest';
import { compileWorkspace } from '@gongfa/blocks';
import { FORMATIONS, formationOf, mergeFormation } from './formations';

const existing = (): Record<string, unknown> => ({
  blocks: {
    languageVersion: 0,
    blocks: [{
      type: 'tick_hat',
      id: 'hat',
      x: 40,
      y: 40,
      inputs: { BODY: { block: {
        type: 'gongfa_array',
        id: 'my-array',
        inputs: { RUNE: { block: { type: 'gongfa_array_rune', id: 'my-rune', fields: { RUNES: 2 } } } },
        next: { block: { type: 'breath', id: 'my-breath' } },
      } } },
    }],
  },
});

function findBlock(node: unknown, id: string): Record<string, unknown> | null {
  if (typeof node !== 'object' || node === null) return null;
  const record = node as Record<string, unknown>;
  if (record.id === id) return record;
  for (const value of Object.values(record)) {
    const hit = findBlock(value, id);
    if (hit !== null) return hit;
  }
  return null;
}

function countArrays(node: unknown): number {
  if (typeof node !== 'object' || node === null) return 0;
  const record = node as Record<string, unknown>;
  let count = record.type === 'gongfa_array' ? 1 : 0;
  for (const value of Object.values(record)) count += countArrays(value);
  return count;
}

describe('阵法阁：只追加、不替换', () => {
  it('四套预设都能编译', () => {
    for (const preset of FORMATIONS) {
      const merged = mergeFormation(undefined, preset);
      const compiled = compileWorkspace(merged.workspace as never);
      expect(compiled.ok, `${preset.name}: ${compiled.errors.join('；')}`).toBe(true);
    }
  });

  it('已有引灵块原样保留：自身的 type/id/inputs 不变，数量 +1', () => {
    const before = existing();
    const originalArray = findBlock(before, 'my-array')!;
    const originalOwn = {
      type: originalArray.type,
      id: originalArray.id,
      inputs: originalArray.inputs,
    };
    const merged = mergeFormation(before, FORMATIONS[0]!);
    const afterArray = findBlock(merged.workspace, 'my-array')!;
    // 不比较 next：追加是接在链尾（现有 breath 之后），原引灵自己的定义必须一字不差。
    expect({ type: afterArray.type, id: afterArray.id, inputs: afterArray.inputs }).toEqual(originalOwn);
    expect(findBlock(merged.workspace, 'my-breath')).not.toBeNull();
    expect(countArrays(before)).toBe(1);
    expect(merged.arraysBefore).toBe(1);
    expect(merged.arraysAfter).toBe(2);
    expect(merged.workspace).not.toBe(before);
  });

  it('空画布/没有入口：自动建入口，阵法进 BODY', () => {
    const merged = mergeFormation(undefined, formationOf('threeTalents')!);
    const compiled = compileWorkspace(merged.workspace as never);
    expect(compiled.ok).toBe(true);
    expect(merged.kept).toBe(0);
    expect(merged.appended).toBe(2); // 引灵 + 阵图
  });

  it('连续拓印两次：两次都追加，id 不重复', () => {
    let current: unknown = existing();
    const first = mergeFormation(current, formationOf('threeTalents')!);
    current = first.workspace;
    const second = mergeFormation(current, formationOf('fourSymbols')!);
    expect(second.arraysBefore).toBe(2);
    expect(second.arraysAfter).toBe(3);
    const ids = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      if (typeof record.id === 'string') {
        expect(ids.has(record.id)).toBe(false);
        ids.add(record.id);
      }
      for (const value of Object.values(record)) walk(value);
    };
    walk(second.workspace);
  });
});
