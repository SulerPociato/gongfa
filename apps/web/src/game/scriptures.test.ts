import { describe, expect, it } from 'vitest';
import { compileWorkspace } from '@gongfa/blocks';
import { SCRIPTURES, canLearn, missingBlocks, scriptureOf } from './scriptures';

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
    expect(canLearn(first, 0, [], 3)).toBe(false);
    expect(canLearn(first, first.cost, [], 3)).toBe(true);
    expect(canLearn(first, 99, [first.id], 3)).toBe(false);
  });

  it('境界不够不能学：炼气学不到「小周天」（它要循环，而循环筑基才给）', () => {
    const zhouTian = SCRIPTURES.find((item) => item.algorithm.includes('for'))!;
    expect(zhouTian.realm).toBe(1);
    expect(canLearn(zhouTian, 99, [], 0)).toBe(false);
    expect(canLearn(zhouTian, 99, [], 1)).toBe(true);
  });

  it('抄录前校验积木：炼气缺循环，会被拦下', () => {
    const zhouTian = SCRIPTURES.find((item) => item.id === 'zhouTian')!;
    const lianQiToolbox = ['breath', 'calm', 'gongfa_compare'];
    expect(missingBlocks(zhouTian, lianQiToolbox)).toContain('gongfa_repeat');
    // 筑基给齐循环后不再缺
    expect(missingBlocks(zhouTian, [...lianQiToolbox, 'gongfa_repeat', 'gongfa_if', 'gongfa_batch'])).toEqual([]);
  });

  it('按 id 能查到，查不到返回 null', () => {
    expect(scriptureOf(SCRIPTURES[0]!.id)?.name).toBe(SCRIPTURES[0]!.name);
    expect(scriptureOf('nope')).toBeNull();
  });
});
