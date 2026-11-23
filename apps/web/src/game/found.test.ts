import { describe, expect, it } from 'vitest';
import type { SaveStorage } from '@gongfa/core';
import { readFound, writeFound, foundKey } from './found';

function memoryStorage(initial: Record<string, string> = {}): SaveStorage {
  const data = new Map(Object.entries(initial));
  return {
    read(key) {
      return data.get(key) ?? null;
    },
    write(key, value) {
      data.set(key, value);
      return true;
    },
    remove(key) {
      data.delete(key);
    },
    keys() {
      return Array.from(data.keys());
    },
  };
}

describe('foundKey', () => {
  it('A 槽 → gongfa:found:A', () => {
    expect(foundKey('A')).toBe('gongfa:found:A');
  });

  it('B 槽 → gongfa:found:B', () => {
    expect(foundKey('B')).toBe('gongfa:found:B');
  });
});

describe('readFound / writeFound', () => {
  it('键不存在 → 空集', () => {
    expect(readFound(memoryStorage(), 'A')).toEqual([]);
  });

  it('写入后读出同一份', () => {
    const storage = memoryStorage();
    writeFound(storage, 'A', ['linear', 'loop']);
    expect(readFound(storage, 'A')).toEqual(['linear', 'loop']);
  });

  it('A 槽与 B 槽隔离', () => {
    const storage = memoryStorage();
    writeFound(storage, 'A', ['linear']);
    writeFound(storage, 'B', ['loop', 'feedback']);
    expect(readFound(storage, 'A')).toEqual(['linear']);
    expect(readFound(storage, 'B')).toEqual(['loop', 'feedback']);
  });

  it('JSON 解析失败 → 空集（不抛）', () => {
    const storage = memoryStorage({ 'gongfa:found:A': 'not json' });
    expect(readFound(storage, 'A')).toEqual([]);
  });

  it('非数组 JSON → 空集', () => {
    const storage = memoryStorage({ 'gongfa:found:A': '{"foo":"bar"}' });
    expect(readFound(storage, 'A')).toEqual([]);
  });

  it('数组里有未知 id → 过滤掉', () => {
    const storage = memoryStorage({ 'gongfa:found:A': '["linear","unknown","loop"]' });
    expect(readFound(storage, 'A')).toEqual(['linear', 'loop']);
  });

  it('数组里有非字符串 → 过滤掉', () => {
    const storage = memoryStorage({ 'gongfa:found:A': '["linear",123,null,"loop"]' });
    expect(readFound(storage, 'A')).toEqual(['linear', 'loop']);
  });

  it('写入失败（storage.write 返回 false）→ 不抛，下次读仍是旧值', () => {
    const storage: SaveStorage = {
      read: () => '["linear"]',
      write: () => false,
      remove: () => {},
      keys: () => [],
    };
    writeFound(storage, 'A', ['loop']);
    expect(readFound(storage, 'A')).toEqual(['linear']);
  });

  // 白名单必须跟着 PATTERNS 表：手写 4 个 id 时 break/while 读档会被静默丢掉，
  // 玩家刷新后谱从 6 退回 4，且集齐 toast 会重弹。
  it('break / while 不会被读档过滤掉', () => {
    const storage: SaveStorage = {
      read: () => '["linear","loop","break","while"]',
      write: () => false,
      remove: () => {},
      keys: () => [],
    };
    expect(readFound(storage, 'A')).toEqual(['linear', 'loop', 'break', 'while']);
  });
});
