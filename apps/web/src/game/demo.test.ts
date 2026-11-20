import { describe, expect, it } from 'vitest';
import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import { loadContent, type Qi, type RealmDef, type SaveStorage } from '@gongfa/core';
import {
  DEMO_RESET_KEY,
  DEMO_SPEED,
  clearGongfaKeys,
  consumeDemoReset,
  demoJumpTarget,
  demoSpeed,
  requestDemoReset,
  type DemoFlagStore,
} from './demo';

// 手搭的表：只为证明「阈值是从表里读的」，不是把 114000 抄进代码。
function realm(id: number, zh: string, threshold: number): RealmDef {
  return { id, name: { zh }, threshold: threshold as Qi, passivePerSec: 0, actionMult: 1 };
}

const TABLE = [
  realm(0, '炼气', 1e3),
  realm(1, '筑基', 1e4),
  realm(2, '金丹', 1.2e5),
  realm(3, '元婴', 8e5),
];

describe('demoJumpTarget', () => {
  it('真表：落在金丹（下一境＝元婴），qi = 该行阈值 × 0.95', () => {
    const content = loadContent({ actions: actionsJson, realms: realmsJson });
    const target = demoJumpTarget(content.realms);
    expect(target).not.toBeNull();
    expect(target?.realmIndex).toBe(2);
    expect(target?.realmName).toBe('金丹');
    expect(target?.qi).toBe(1.2e5 * 0.95);
    expect(target?.qi).toBe(114000);
  });

  it('表驱动：阈值改了跟着改，代码里不许留 114000', () => {
    const moved = [realm(0, '炼气', 1e3), realm(1, '筑基', 1e4), realm(2, '金丹', 1e6), realm(3, '元婴', 8e6)];
    expect(demoJumpTarget(moved)?.qi).toBe(950000);
  });

  it('fraction 是参数，不是常量', () => {
    expect(demoJumpTarget(TABLE, 0.5)?.qi).toBe(60000);
  });

  it('表里没有元婴 → null（不拿 undefined 当阈值）', () => {
    expect(demoJumpTarget([realm(0, '炼气', 1e3), realm(1, '筑基', 1e4)])).toBeNull();
  });

  it('元婴排在首行（没有前一行）→ null', () => {
    expect(demoJumpTarget([realm(3, '元婴', 8e5), realm(0, '炼气', 1e3)])).toBeNull();
  });
});

describe('demoSpeed', () => {
  it('演示 3×，正式 1×', () => {
    expect(demoSpeed(true)).toBe(DEMO_SPEED);
    expect(demoSpeed(true)).toBe(3);
    expect(demoSpeed(false)).toBe(1);
  });
});

function fakeStore(): DemoFlagStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    read: (key) => map.get(key) ?? null,
    write: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

describe('重置标记', () => {
  it('没标记时 consume 返回 false，且不写键', () => {
    const store = fakeStore();
    expect(consumeDemoReset(store)).toBe(false);
    expect(store.map.size).toBe(0);
  });

  it('consume 读一次就自删：第二次拿到 false', () => {
    const store = fakeStore();
    requestDemoReset(store);
    expect(store.read(DEMO_RESET_KEY)).not.toBeNull();
    expect(consumeDemoReset(store)).toBe(true);
    expect(consumeDemoReset(store)).toBe(false);
  });
});

describe('clearGongfaKeys', () => {
  it('只删 gongfa: 前缀，返回删掉的条数', () => {
    const data = new Map<string, string>([
      ['gongfa:save:A', '{}'],
      ['gongfa:save:B', '{}'],
      ['gongfa:active', 'A'],
      ['gongfa:settings', '{"offlineBreakthrough":true}'],
      ['gongfa:tutorial', 'done'],
      ['other-app:key', 'keep me'],
    ]);
    const storage: SaveStorage = {
      read: (key) => data.get(key) ?? null,
      write: (key, value) => {
        data.set(key, value);
        return true;
      },
      remove: (key) => void data.delete(key),
      keys: () => [...data.keys()].filter((key) => key.startsWith('gongfa:')),
    };
    expect(clearGongfaKeys(storage)).toBe(5);
    expect([...data.keys()]).toEqual(['other-app:key']);
  });
});
