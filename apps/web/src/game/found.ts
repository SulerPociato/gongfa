import { PATTERNS, type PatternId, type SaveStorage } from '@gongfa/core';

// 批次 3：功法谱发现记录（任务 8 续）。
// 与 gongfa:save:A / gongfa:active 同命名空间，按槽隔离：B 档不该看到 A 档的谱。
// 键名 = `gongfa:found:${slot}`，值是 JSON 数组（PatternId[]），解析失败回空集（不崩页面）。

const NAMESPACE = 'gongfa:found:';

export function foundKey(slot: 'A' | 'B'): string {
  return `${NAMESPACE}${slot}`;
}

/**
 * 读当前活动槽的发现记录。
 * 指针缺失 / JSON 解析失败 / 数组里有未知 id → 一律回空集（不抛、不报红字）。
 * 坏档可以接受，整页崩掉不行（与 storage.ts 的兜底哲学一致）。
 */
export function readFound(storage: SaveStorage, slot: 'A' | 'B'): readonly PatternId[] {
  const text = storage.read(foundKey(slot));
  if (text === null) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is PatternId => typeof id === 'string' && isValidPatternId(id));
  } catch {
    return [];
  }
}

/**
 * 写发现记录。宿主在识别到新图案时调用，传入新的完整集合（不是增量）。
 * 写入失败（配额满）不抛：下次识别时会再试一次，玩家最多晚几秒看到卡片。
 */
export function writeFound(storage: SaveStorage, slot: 'A' | 'B', ids: readonly PatternId[]): void {
  storage.write(foundKey(slot), JSON.stringify(ids));
}

function isValidPatternId(id: string): id is PatternId {
  // 白名单必须跟着 PATTERNS 表走：第一版手写了 4 个 id，新增 break/while 之后
  // 读档时被这里过滤掉 —— 谱永远停在 4/6，且集齐 toast 每次都重弹（评审实测）。
  return PATTERNS.some((pattern) => pattern.id === id);
}
