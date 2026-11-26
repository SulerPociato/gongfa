import { describe, expect, it } from 'vitest';
import type { SaveStorage } from '@gongfa/core';
import { foundKey, readFound, writeFound } from './found';

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

// 2026-11-26：功法谱从不带槽的全局键读，旧的按槽键首次读取时并集迁移。
// 原因：存档 A/B 每 30 秒轮换，按槽存会在刷新后读到空表。
describe('foundKey', () => {
  it('不带槽位', () => {
    expect(foundKey()).toBe('gongfa:found');
  });
});

describe('readFound / writeFound', () => {
  it('键不存在 → 空集', () => {
    expect(readFound(memoryStorage())).toEqual([]);
  });

  it('写入后读出同一份', () => {
    const storage = memoryStorage();
    writeFound(storage, ['linear', 'loop']);
    expect(readFound(storage)).toEqual(['linear', 'loop']);
  });

  it('旧 A/B 两份并集迁移到全局，并写回', () => {
    const storage = memoryStorage({
      'gongfa:found:A': '["linear"]',
      'gongfa:found:B': '["loop","linear"]',
    });
    expect(readFound(storage)).toEqual(['linear', 'loop']);
    expect(storage.read('gongfa:found')).toBe('["linear","loop"]');
  });

  it('全局存在时不再读旧槽', () => {
    const storage = memoryStorage({
      'gongfa:found': '["linear"]',
      'gongfa:found:A': '["loop"]',
    });
    expect(readFound(storage)).toEqual(['linear']);
  });

  it('JSON 解析失败 → 空集（不抛）', () => {
    expect(readFound(memoryStorage({ 'gongfa:found': 'not json' }))).toEqual([]);
  });

  it('非数组 JSON → 空集', () => {
    expect(readFound(memoryStorage({ 'gongfa:found': '{"foo":"bar"}' }))).toEqual([]);
  });

  it('数组里有未知 id / 非字符串 → 过滤掉', () => {
    const storage = memoryStorage({ 'gongfa:found': '["linear",123,null,"unknown","loop"]' });
    expect(readFound(storage)).toEqual(['linear', 'loop']);
  });

  it('写入失败（storage.write 返回 false）→ 不抛，下次读仍是旧值', () => {
    const storage: SaveStorage = {
      read: () => '["linear"]',
      write: () => false,
      remove: () => {},
      keys: () => [],
    };
    writeFound(storage, ['loop']);
    expect(readFound(storage)).toEqual(['linear']);
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
    expect(readFound(storage)).toEqual(['linear', 'loop', 'break', 'while']);
  });
});
