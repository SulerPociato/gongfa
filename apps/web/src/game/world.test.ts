import { describe, expect, it } from 'vitest';
import { CODEX_GROUPS, DOMAINS, PILLS, REALM_LADDER, ROOTS, SECTS, TREASURES } from './world';

describe('世界观图鉴数据', () => {
  it('境界 9 + 仙界 5；界域 10；宗门 9；丹药 8；法宝 3；灵根 6', () => {
    expect(REALM_LADDER).toHaveLength(14);
    expect(DOMAINS).toHaveLength(10);
    expect(SECTS).toHaveLength(9);
    expect(PILLS).toHaveLength(8);
    expect(TREASURES).toHaveLength(3);
    expect(ROOTS).toHaveLength(6);
  });

  it('每条都有设定与计算机对照，且 id 全局唯一', () => {
    const ids = new Set<string>();
    for (const group of CODEX_GROUPS) {
      for (const item of group.entries) {
        expect(item.note.trim().length, item.id).toBeGreaterThan(4);
        expect(item.analog.trim().length, item.id).toBeGreaterThan(4);
        expect(ids.has(item.id), item.id).toBe(false);
        ids.add(item.id);
      }
    }
  });

  it('9 境全部可玩；6 种灵根都可玩', () => {
    expect(REALM_LADDER.filter((item) => item.playable === true).map((item) => item.name)).toEqual(['练气', '筑基', '结丹（金丹）', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫']);
    expect(ROOTS.filter((item) => item.playable === true)).toHaveLength(6);
  });

  it('分组覆盖全部数据，且每组都有标题/说明', () => {
    expect(CODEX_GROUPS).toHaveLength(6);
    for (const group of CODEX_GROUPS) {
      expect(group.title.length).toBeGreaterThan(1);
      expect(group.note.length).toBeGreaterThan(2);
      expect(group.entries.length).toBeGreaterThan(0);
    }
  });
});
