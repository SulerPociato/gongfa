import { describe, expect, it } from 'vitest';
import type { SaveStorage } from '@gongfa/core';
import { readAwarded, readInsight, readLearned, writeAwarded, writeInsight, writeLearned } from './insightStore';

function storage(initial: Record<string, string> = {}): SaveStorage {
  const map = new Map(Object.entries(initial));
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => { map.set(key, value); return true; },
    remove: (key) => { map.delete(key); },
    keys: () => [...map.keys()],
  };
}

describe('悟道/已学/来源账本（元进度）', () => {
  it('余额写读，负数/非数字回 0', () => {
    const s = storage();
    writeInsight(s, 7);
    expect(readInsight(s)).toBe(7);
    writeInsight(s, -3);
    expect(readInsight(s)).toBe(0);
    expect(readInsight(storage({ 'gongfa:insight': 'x' }))).toBe(0);
  });

  it('已学功法去重保存', () => {
    const s = storage();
    writeLearned(s, ['a', 'b', 'a']);
    expect([...readLearned(s)].sort()).toEqual(['a', 'b']);
  });

  it('来源账本：写读去重、坏 JSON 回空', () => {
    const s = storage();
    writeAwarded(s, ['pattern:a', 'trial:0', 'pattern:a']);
    expect([...readAwarded(s)].sort()).toEqual(['pattern:a', 'trial:0']);
    expect(readAwarded(storage({ 'gongfa:insight:awarded': '{' }))).toEqual([]);
    expect(readAwarded(storage())).toEqual([]);
  });
});
