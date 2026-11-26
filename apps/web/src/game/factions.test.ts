import { describe, expect, it } from 'vitest';
import type { SaveStorage } from '@gongfa/core';
import {
  DOMAIN_EFFECTS,
  SECT_EFFECTS,
  describeEffect,
  factionDemon,
  factionRate,
  readDomain,
  readSect,
  writeDomain,
  writeSect,
} from './factions';

function memoryStorage(initial: Record<string, string> = {}): SaveStorage {
  const data = new Map(Object.entries(initial));
  return {
    read: (key) => data.get(key) ?? null,
    write: (key, value) => { data.set(key, value); return true; },
    remove: (key) => { data.delete(key); },
    keys: () => [...data.keys()],
  };
}

describe('宗门/界域效果', () => {
  it('9 宗门 / 10 界域都有数值，null 为 1', () => {
    expect(Object.keys(SECT_EFFECTS)).toHaveLength(9);
    expect(Object.keys(DOMAIN_EFFECTS)).toHaveLength(10);
    expect(factionRate(SECT_EFFECTS, null)).toBe(1);
    expect(factionDemon(DOMAIN_EFFECTS, null)).toBe(1);
    expect(factionRate(SECT_EFFECTS, 'swordGate')).toBeCloseTo(1.06);
    expect(factionDemon(SECT_EFFECTS, 'buddhaTemple')).toBeCloseTo(0.88);
    expect(factionDemon(DOMAIN_EFFECTS, 'ghostDomain')).toBeCloseTo(1.1);
  });

  it('未知 id 不生效，描述为空/单项都写对', () => {
    expect(factionRate(SECT_EFFECTS, 'nope')).toBe(1);
    expect(describeEffect(undefined)).toBe('无额外修正');
    expect(describeEffect({ rate: 1.06 })).toBe('产出 ×1.06');
    expect(describeEffect({ rate: 1.1, demon: 1.08 })).toBe('产出 ×1.10 · 心魔 ×1.08');
  });

  it('读档只认表里有的 id；写入/清除可往返', () => {
    const storage = memoryStorage({ 'gongfa:sect': 'swordGate', 'gongfa:domain': 'nope' });
    expect(readSect(storage)).toBe('swordGate');
    expect(readDomain(storage)).toBeNull();
    writeDomain(storage, 'seaRealm');
    expect(readDomain(storage)).toBe('seaRealm');
    writeSect(storage, null);
    expect(readSect(storage)).toBeNull();
  });
});
