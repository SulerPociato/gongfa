import { describe, expect, it } from 'vitest';
import { compileWorkspace } from '@gongfa/blocks';
import { SCRIPTURES, canLearn, scriptureOf } from './scriptures';

describe('藏经阁（主动学功法）', () => {
  it('每套功法都能编译成合法程序', () => {
    for (const scripture of SCRIPTURES) {
      const compiled = compileWorkspace(scripture.workspace() as never);
      expect(compiled.ok, `${scripture.name}: ${compiled.errors.join('；')}`).toBe(true);
      expect(compiled.program!.code.length).toBeGreaterThan(1);
    }
  });

  it('成本按难度递增，且没有重复 id', () => {
    const costs = SCRIPTURES.map((item) => item.cost);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    expect(new Set(SCRIPTURES.map((item) => item.id)).size).toBe(SCRIPTURES.length);
  });

  it('悟道不够不能学，学过不能重复学', () => {
    const first = SCRIPTURES[0]!;
    expect(canLearn(first, 0, [])).toBe(false);
    expect(canLearn(first, first.cost, [])).toBe(true);
    expect(canLearn(first, 99, [first.id])).toBe(false);
  });

  it('按 id 能查到，查不到返回 null', () => {
    expect(scriptureOf(SCRIPTURES[0]!.id)?.name).toBe(SCRIPTURES[0]!.name);
    expect(scriptureOf('nope')).toBeNull();
  });
});
