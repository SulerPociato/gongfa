/**
 * 宗门与界域（2026-11-26）：从图鉴设定变成**可选、可改数值**的出身。
 *
 * 每个选项只改两件事：产出倍率、心魔倍率。两者都乘进现有乘数链（与道途/法宝/书同一条），
 * 不新增资源、不新增存档字段（元进度 gongfa:sect / gongfa:domain，带槽会随 A/B 轮换丢）。
 */
import type { SaveStorage } from '@gongfa/core';

export interface FactionEffect {
  /** 产出乘数，默认 1。 */
  readonly rate?: number;
  /** 心魔倍率，默认 1。 */
  readonly demon?: number;
}

export const SECT_EFFECTS: Readonly<Record<string, FactionEffect>> = {
  swordGate: { rate: 1.06 },
  buddhaTemple: { demon: 0.88 },
  wuweiSect: { rate: 1.03, demon: 0.96 },
  heavenSwordAcademy: { rate: 1.04 },
  bodhiAcademy: { demon: 0.92 },
  celestialPavilion: { rate: 1.03 },
  artifactSect: { rate: 1.02 },
  demonSect: { rate: 1.1, demon: 1.08 },
  heavenDemonCult: { rate: 1.12, demon: 1.15 },
};

export const DOMAIN_EFFECTS: Readonly<Record<string, FactionEffect>> = {
  voidHeaven: { rate: 1.04 },
  cloudDharma: { demon: 0.94 },
  heavenCapital: { rate: 1.03 },
  jadePond: { demon: 0.96 },
  cultivationWorld: { rate: 1.02 },
  mortalWorld: { demon: 0.98 },
  seaRealm: { rate: 1.02 },
  ghostDomain: { rate: 1.1, demon: 1.1 },
  demonDomain: { rate: 1.12, demon: 1.08 },
  beastDomain: { rate: 1.12, demon: 1.06 },
};

export function factionRate(table: Readonly<Record<string, FactionEffect>>, id: string | null): number {
  if (id === null) return 1;
  const value = table[id]?.rate;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

export function factionDemon(table: Readonly<Record<string, FactionEffect>>, id: string | null): number {
  if (id === null) return 1;
  const value = table[id]?.demon;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

/** UI 用：把「产出 ×1.06 / 心魔 ×0.88」拼成一句。 */
export function describeEffect(effect: FactionEffect | undefined): string {
  if (effect === undefined) return '无额外修正';
  const parts: string[] = [];
  if (effect.rate !== undefined) parts.push(`产出 ×${effect.rate.toFixed(2)}`);
  if (effect.demon !== undefined) parts.push(`心魔 ×${effect.demon.toFixed(2)}`);
  return parts.length === 0 ? '无额外修正' : parts.join(' · ');
}

const SECT_KEY = 'gongfa:sect';
const DOMAIN_KEY = 'gongfa:domain';

export function readSect(storage: SaveStorage): string | null {
  const value = storage.read(SECT_KEY);
  return value !== null && SECT_EFFECTS[value] !== undefined ? value : null;
}

export function readDomain(storage: SaveStorage): string | null {
  const value = storage.read(DOMAIN_KEY);
  return value !== null && DOMAIN_EFFECTS[value] !== undefined ? value : null;
}

export function writeSect(storage: SaveStorage, id: string | null): void {
  if (id === null) storage.remove(SECT_KEY);
  else storage.write(SECT_KEY, id);
}

export function writeDomain(storage: SaveStorage, id: string | null): void {
  if (id === null) storage.remove(DOMAIN_KEY);
  else storage.write(DOMAIN_KEY, id);
}
