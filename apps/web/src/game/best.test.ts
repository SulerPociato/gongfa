import { describe, expect, it } from 'vitest';
import type { SaveStorage } from '@gongfa/core';
import { readBest, writeBest } from './best';

function memoryStorage(initial: Record<string, string> = {}): SaveStorage & { dump: () => Record<string, string> } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      map.set(key, value);
      return true;
    },
    remove: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
    dump: () => Object.fromEntries(map),
  };
}

describe('试炼最佳效率（元进度 gongfa:best）', () => {
  it('空存储读成空表', () => {
    expect(readBest(memoryStorage())).toEqual({});
  });

  it('写入后读回同一张表，且键不带槽位', () => {
    const storage = memoryStorage();
    writeBest(storage, { 0: 0.527, 2: 1.25 });
    expect(readBest(storage)).toEqual({ 0: 0.527, 2: 1.25 });
    expect(Object.keys(storage.dump())).toEqual(['gongfa:best']);
  });

  it('坏 JSON / 非对象 / 负值一律忽略，不抛错', () => {
    expect(readBest(memoryStorage({ 'gongfa:best': 'not json' }))).toEqual({});
    expect(readBest(memoryStorage({ 'gongfa:best': '"text"' }))).toEqual({});
    expect(readBest(memoryStorage({ 'gongfa:best': '{"0":-1,"1":"x","2":2.5}' }))).toEqual({ 2: 2.5 });
  });
});
