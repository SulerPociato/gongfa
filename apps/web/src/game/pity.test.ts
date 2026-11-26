import { describe, expect, it } from 'vitest';
import type { SaveStorage } from '@gongfa/core';
import { clearPity, PITY_KEY, readPity, writePity } from './pity';

function storage(initial: Record<string, string> = {}): SaveStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    read: (key) => map.get(key) ?? null,
    write: (key, value) => { map.set(key, value); return true; },
    remove: (key) => { map.delete(key); },
    keys: () => [...map.keys()],
  };
}

// 契约 §7.1 的保底要跨刷新；这一层只负责「第几次」不丢，不改骰值。
// 不带槽：A/B 轮换会丢（与 gongfa:dao 同因）。
describe('保底元进度 gongfa:pity', () => {
  it('写入后读回同一个境界/次数，key 不带槽位', () => {
    const s = storage();
    writePity(s, { realm: 1, attempt: 2 });
    expect(s.map.get(PITY_KEY)).toBe('{"realm":1,"attempt":2}');
    expect(readPity(s)).toEqual({ realm: 1, attempt: 2 });
    expect([...s.map.keys()].some((key) => key.endsWith(':A') || key.endsWith(':B'))).toBe(false);
  });

  it('attempt <= 1 视为没有连败：写入会清掉旧记录', () => {
    const s = storage({ [PITY_KEY]: '{"realm":1,"attempt":2}' });
    writePity(s, { realm: 1, attempt: 1 });
    expect(readPity(s)).toBeNull();
  });

  it('坏 JSON / 越界 / 负数：当没有记录，不抛', () => {
    for (const raw of ['x', '{}', '{"realm":1,"attempt":9}', '{"realm":-1,"attempt":2}', '{"realm":"1","attempt":2}']) {
      const s = storage({ [PITY_KEY]: raw });
      expect(readPity(s)).toBeNull();
    }
  });

  it('读端口抛异常时返回 null，不把开局拖崩', () => {
    const s: SaveStorage = {
      read: () => { throw new Error('quota'); },
      write: () => true,
      remove: () => {},
      keys: () => [],
    };
    expect(readPity(s)).toBeNull();
  });

  it('clearPity 删掉记录', () => {
    const s = storage({ [PITY_KEY]: '{"realm":1,"attempt":3}' });
    clearPity(s);
    expect(readPity(s)).toBeNull();
  });
});
