import { describe, expect, it } from 'vitest';
import type { SaveStorage } from '@gongfa/core';
import { PILLS, consumePill, grantPill, pillForRealm, pillOf, readPills, writePills } from './pills';

function memoryStorage(initial: Record<string, string> = {}): SaveStorage {
  const data = new Map(Object.entries(initial));
  return {
    read: (key) => data.get(key) ?? null,
    write: (key, value) => { data.set(key, value); return true; },
    remove: (key) => { data.delete(key); },
    keys: () => [...data.keys()],
  };
}

describe('丹药库存', () => {
  it('8 种丹，id 唯一，前 8 境各掉一种', () => {
    expect(PILLS).toHaveLength(8);
    expect(new Set(PILLS.map((pill) => pill.id)).size).toBe(8);
    expect(Array.from({ length: 8 }, (_, i) => pillForRealm(i).id)).toEqual(PILLS.map((pill) => pill.id));
    expect(pillOf('nope')).toBeNull();
  });

  it('授予/消耗/清除，库存按 JSON 往返', () => {
    const storage = memoryStorage();
    expect(readPills(storage)).toEqual({});
    grantPill(storage, 'marrowPill');
    grantPill(storage, 'marrowPill', 2);
    expect(readPills(storage)).toEqual({ marrowPill: 3 });
    expect(consumePill(storage, 'marrowPill')).toEqual({ marrowPill: 2 });
    expect(consumePill(storage, 'marrowPill')).toEqual({ marrowPill: 1 });
    expect(consumePill(storage, 'marrowPill')).toEqual({});
    expect(consumePill(storage, 'marrowPill')).toBeNull();
  });

  it('坏 JSON/未知丹/负数被过滤，写入失败不抛', () => {
    expect(readPills(memoryStorage({ 'gongfa:pills': 'nope' }))).toEqual({});
    expect(readPills(memoryStorage({ 'gongfa:pills': '{"unknown":1,"marrowPill":-2,"foundationPill":2}' }))).toEqual({ foundationPill: 2 });
    const storage: SaveStorage = {
      read: () => '{"marrowPill":1}',
      write: () => false,
      remove: () => {},
      keys: () => [],
    };
    expect(() => writePills(storage, { marrowPill: 2 })).not.toThrow();
  });
});
