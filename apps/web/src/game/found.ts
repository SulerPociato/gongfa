import { PATTERNS, type PatternId, type SaveStorage } from '@gongfa/core';

// 批次 3：功法谱发现记录。
// 2026-11-26 修正：原来按槽存 `gongfa:found:<slot>`，但存档 A/B 每 30 秒轮换一次，
// 写入时的槽与刷新后 activeSlot 的槽可能不是同一个 —— 玩家会看到「谱突然清零」。
// 与 `gongfa:best` / `gongfa:dao` / `gongfa:insight` 同因，改为**不带槽**的全局元进度；
// 首次读取时把旧的 A/B 两份并集迁移过来。
const NAMESPACE = 'gongfa:found';
const LEGACY_SLOTS = ['A', 'B'] as const;

export function foundKey(): string {
  return NAMESPACE;
}

function parse(text: string | null): readonly PatternId[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is PatternId => typeof id === 'string' && isValidPatternId(id));
  } catch {
    return [];
  }
}

/**
 * 读功法谱：先读全局键；没有就尝试把旧的按槽键并集迁移过来（一次性写回全局）。
 * 坏 JSON / 未知 id / 非数组一律当空，不抛。
 */
export function readFound(storage: SaveStorage): readonly PatternId[] {
  const direct = parse(storage.read(NAMESPACE));
  if (direct.length > 0) return direct;
  const legacy = LEGACY_SLOTS.flatMap((slot) => parse(storage.read(`${NAMESPACE}:${slot}`)));
  const merged = [...new Set(legacy)];
  if (merged.length > 0) storage.write(NAMESPACE, JSON.stringify(merged));
  return merged;
}

/** 写功法谱（完整集合，不是增量）；写入失败不抛，下次识别时还会再写。 */
export function writeFound(storage: SaveStorage, ids: readonly PatternId[]): void {
  storage.write(NAMESPACE, JSON.stringify([...new Set(ids)]));
}

function isValidPatternId(id: string): id is PatternId {
  // 白名单必须跟着 PATTERNS 表走：第一版手写了 4 个 id，新增 break/while 之后
  // 读档时被这里过滤掉 —— 谱永远停在 4/6，且集齐 toast 每次都重弹（评审实测）。
  return PATTERNS.some((pattern) => pattern.id === id);
}
