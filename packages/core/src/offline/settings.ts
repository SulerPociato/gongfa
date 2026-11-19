import type { SaveStorage } from '../save/storage';

// 玩家偏好，不是存档（评审 Q1）：契约 §5.1 的 GameState 没有对应字段，
// 塞进 state 会被 validateState 以「未知字段」打回，加字段又要把 schemaVersion 升到 v2 走整条迁移链。
// 存这里，存档槽保持 v1，两不相欠。纯前端 localStorage 没有防改档能力（契约 §8）。

/** 键名带命名空间，和 gongfa:save:A / gongfa:active 同族，devtools 里能直接改。 */
export const SETTINGS_KEY = 'gongfa:settings';

const OFFLINE_BREAKTHROUGH_KEY = 'offlineBreakthrough';

export interface GameSettings {
  /** 契约 §7.1 离线行：开了才在闭关里尝试渡劫，每次最多 1 次。默认关闭。 */
  readonly offlineBreakthrough: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = { offlineBreakthrough: false };

export interface SettingsRead {
  readonly settings: GameSettings;
  readonly errors: readonly string[];
}

// 坏值一律回落默认 + 留一句话：设置面板读不出「你写错的那个键」比读不出开关更让人抓狂。
export function parseSettings(text: string | null): SettingsRead {
  const errors: string[] = [];
  if (text === null || text === '') return { settings: DEFAULT_SETTINGS, errors };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { settings: DEFAULT_SETTINGS, errors: [`${SETTINGS_KEY} 不是合法 JSON，已按默认设置运行`] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { settings: DEFAULT_SETTINGS, errors: [`${SETTINGS_KEY} 需要对象，收到 ${JSON.stringify(raw)}，已按默认设置运行`] };
  }
  const record = raw as Record<string, unknown>;

  const known = record[OFFLINE_BREAKTHROUGH_KEY];
  let offlineBreakthrough = DEFAULT_SETTINGS.offlineBreakthrough;
  if (known === undefined) errors.push(`${SETTINGS_KEY} 缺少 ${OFFLINE_BREAKTHROUGH_KEY}，按默认关闭`);
  else if (typeof known === 'boolean') offlineBreakthrough = known;
  else errors.push(`${SETTINGS_KEY}.${OFFLINE_BREAKTHROUGH_KEY} 需要 true 或 false，收到 ${JSON.stringify(known)}`);

  for (const key of Object.keys(record)) {
    if (key !== OFFLINE_BREAKTHROUGH_KEY) errors.push(`${SETTINGS_KEY} 有未识别的设置项 ${key}，已忽略`);
  }
  return { settings: { offlineBreakthrough }, errors };
}

export function readSettings(storage: SaveStorage): SettingsRead {
  return parseSettings(storage.read(SETTINGS_KEY));
}

export function writeSettings(storage: SaveStorage, settings: GameSettings): boolean {
  return storage.write(SETTINGS_KEY, JSON.stringify({ offlineBreakthrough: settings.offlineBreakthrough }));
}
