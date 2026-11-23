import type { Clock } from '../types';
import { issueText, parseEnvelope, serializeSave, validateSave, type SaveFile } from './schema';
import { migrate } from './migrate';

// 契约 §2.6 / §5.2 第 4 步：双槽 + 指针，写先写数据槽、后切指针。
// core 只认这个 keyed 端口，不碰 localStorage：read 缺失返回 null、write 失败返回 false，一律不抛。
export interface SaveStorage {
  read(key: string): string | null;
  write(key: string, value: string): boolean;
  remove(key: string): void;
  keys(): string[];
}

// 两个数据槽 + 一个指针，键名带命名空间：浏览器里同域别的游戏也在写 localStorage。
export const SLOT_NAMES = ['A', 'B'] as const;
export const SLOT_KEYS: readonly [string, string] = [`gongfa:save:${SLOT_NAMES[0]}`, `gongfa:save:${SLOT_NAMES[1]}`];
export const ACTIVE_KEY = 'gongfa:active';
export const CORRUPTED_PREFIX = 'gongfa:corrupted-';

// 存档体积上限，按 UTF-16 code unit 计（= 字符串 length，与浏览器配额同口径）。
// 超限是拒写而不是先删旧档：玩家丢的只是这一次改动，不是整份进度。
export const MAX_SAVE_CHARS = 262144;

export type DecodeStage = 'envelope' | 'migrate' | 'validate';

export interface DecodeResult {
  ok: boolean;
  /** 失败发生在哪一步；成功为 null（契约 §5.2 的固定顺序） */
  stage: DecodeStage | null;
  errors: string[];
  save: SaveFile | null;
}

// envelope → 迁移 → 校验，三步串好，任何一步失败都带得出 stage。
export function decodeSave(text: string): DecodeResult {
  const envelope = parseEnvelope(text);
  if (!envelope.ok) return { ok: false, stage: 'envelope', errors: envelope.errors, save: null };

  const migrated = migrate(envelope.raw);
  if (!migrated.ok) return { ok: false, stage: 'migrate', errors: migrated.errors, save: null };

  const validated = validateSave(migrated.value);
  if (!validated.ok) return { ok: false, stage: 'validate', errors: validated.errors.map(issueText), save: null };

  return { ok: true, stage: null, errors: [], save: validated.save };
}

function slotName(index: number): 'A' | 'B' {
  return SLOT_NAMES[index] ?? 'A';
}

// 读端口本身也可能抛（Safari 隐私模式、配额异常），一律挡住：坏档可以接受，整页崩掉不行。
function safeRead(storage: SaveStorage, key: string): string | null {
  try {
    return storage.read(key);
  } catch (error) {
    return `__throw__:${(error as Error).message}`;
  }
}

function safeWrite(storage: SaveStorage, key: string, text: string): boolean {
  try {
    return storage.write(key, text) === true;
  } catch (error) {
    console.warn(`存档写入 ${key} 抛出：${(error as Error).message}`);
    return false;
  }
}

function safeRemove(storage: SaveStorage, key: string): void {
  try {
    storage.remove(key);
  } catch (error) {
    console.warn(`存档清理 ${key} 抛出：${(error as Error).message}`);
  }
}

function activeIndex(storage: SaveStorage): number | null {
  const pointer = safeRead(storage, ACTIVE_KEY);
  const index = SLOT_NAMES.indexOf(pointer as 'A' | 'B');
  return index < 0 ? null : index;
}

/**
 * 当前活动槽名（'A' | 'B'）。指针缺失或非法时默认 'A'（与 writeSave 的首次写入目标一致）。
 * 宿主用这个键名派生其他按槽隔离的状态（例如 gongfa:found:A）。
 */
export function activeSlot(storage: SaveStorage): 'A' | 'B' {
  const index = activeIndex(storage);
  return slotName(index === null ? 0 : index);
}

export interface WriteResult {
  ok: boolean;
  /** 文本长度（UTF-16 code unit），用于体积告警与测试断言 */
  bytes: number;
  slot: 'A' | 'B' | null;
  errors: string[];
}

// 落盘。先写备用数据槽、成功后才切指针：中途失败（配额满）就还是上一份好档。
export function writeSave(storage: SaveStorage, save: SaveFile, clock: Clock): WriteResult {
  const validated = validateSave(save);
  if (!validated.ok) {
    const errors = validated.errors.map(issueText);
    return { ok: false, bytes: 0, slot: null, errors: [`存档状态非法，已拒绝写入：${errors[0]}（共 ${errors.length} 条）`] };
  }

  // lastSeenAt 以落盘时刻为准：它是离线结算的起点，快照晚了几秒就该由这里补齐，不能靠调用方记得刷新。
  const stamped: SaveFile = { ...save, state: { ...save.state, lastSeenAt: clock.now() } };
  const text = serializeSave(stamped);
  if (text.length > MAX_SAVE_CHARS) {
    // 一个 key 都不碰：不能先删旧档再报错
    return { ok: false, bytes: text.length, slot: null, errors: [`存档过大：${text.length} 字符，上限 ${MAX_SAVE_CHARS}，本次未写入`] };
  }

  const current = activeIndex(storage);
  const target = current === null ? 0 : 1 - current;
  if (!safeWrite(storage, SLOT_KEYS[target] ?? '', text)) {
    return { ok: false, bytes: text.length, slot: null, errors: [`写入失败：${slotName(target)} 槽（配额满或存储不可用），保留 ${slotName(current ?? 0)} 槽旧档`] };
  }
  if (!safeWrite(storage, ACTIVE_KEY, slotName(target))) {
    // 数据槽写了但指针没切：读档仍拿上一份，一致，只是这次改动没生效
    return { ok: false, bytes: text.length, slot: null, errors: [`写入失败：${ACTIVE_KEY} 指针`] };
  }

  return { ok: true, bytes: text.length, slot: slotName(target), errors: [] };
}

// 坏档另存一份，别静默丢掉：玩家手改坏了也要能自己看出来改在哪儿。
// 同一时间戳再坏一次不覆盖上一份，退到 -2、-3。
export function backupCorrupted(storage: SaveStorage, atMs: number, text: string): string {
  let key = `${CORRUPTED_PREFIX}${atMs}`;
  for (let attempt = 2; safeRead(storage, key) !== null; attempt += 1) key = `${CORRUPTED_PREFIX}${atMs}-${attempt}`;
  safeWrite(storage, key, text);
  return key;
}

export interface ReadResult {
  ok: boolean;
  /** 两个槽都没档：宿主该开新档，而不是报错 */
  fresh: boolean;
  save: SaveFile | null;
  /** 主槽坏了、靠备用槽救回来 */
  fellBack: boolean;
  /** 两槽都坏时坏档另存的 key；没备份就是 null */
  corruptedKey: string | null;
  stage: DecodeStage | null;
  /** 字段级明细：只给宿主打日志/展开用，不要整份渲染进 UI */
  errors: string[];
  /** 给玩家看的一句话（损坏开新档、回退备用槽）；没有异常就是 null */
  summary: string | null;
}

export function clearSaves(storage: SaveStorage): void {
  for (const key of SLOT_KEYS) safeRemove(storage, key);
  safeRemove(storage, ACTIVE_KEY);
}

const EMPTY: ReadResult = { ok: false, fresh: true, save: null, fellBack: false, corruptedKey: null, stage: null, errors: [], summary: null };

// 读档：按指针决定主/备，主槽坏了回退备用槽，两槽都坏才开新档。
export function readSave(storage: SaveStorage, clock: Clock): ReadResult {
  const current = activeIndex(storage);
  const order = current === null ? [0, 1] : [current, 1 - current];
  const texts = order.map((index) => ({ index, text: safeRead(storage, SLOT_KEYS[index] ?? '') }));
  const real = texts.filter((entry) => entry.text !== null);
  if (real.length === 0) return { ...EMPTY };

  const failures: string[] = [];
  let primaryStage: DecodeStage | null = null;
  for (const [position, entry] of texts.entries()) {
    if (entry.text === null) {
      failures.push(`${slotName(entry.index)} 槽无存档`);
      continue;
    }
    // 读端口抛出来的字符串不是存档文本，按坏档处理
    const decoded = entry.text.startsWith('__throw__:')
      ? { ok: false as const, stage: 'envelope' as DecodeStage, errors: [`存档读取抛异常：${entry.text.slice(10)}`], save: null }
      : decodeSave(entry.text);
    if (decoded.ok) {
      const backup = slotName(entry.index);
      return {
        ok: true,
        fresh: false,
        save: decoded.save,
        fellBack: position > 0,
        corruptedKey: null,
        stage: null,
        errors: failures,
        summary: position > 0 ? `主存档（${slotName(order[0] ?? 0)} 槽）不可用，已回退 ${backup} 槽继续` : null,
      };
    }
    failures.push(`${slotName(entry.index)} 槽：${decoded.errors.join('；')}`);
    if (position === 0) primaryStage = decoded.stage;
  }

  // 两槽都不可用：坏档另存 + 清槽，下一次进来就是干净的新档
  const primaryText = texts[0]?.text ?? texts[1]?.text ?? '';
  const corruptedKey = backupCorrupted(storage, clock.now(), primaryText.startsWith('__throw__:') ? '' : primaryText);
  clearSaves(storage);
  return {
    ok: false,
    fresh: true,
    save: null,
    fellBack: false,
    corruptedKey,
    stage: primaryStage ?? 'envelope',
    errors: [`两槽都校验失败：${failures.join('、')}`, `坏档已另存到 ${corruptedKey}`],
    summary: `存档已损坏，已备份为 ${corruptedKey}，已开新档`,
  };
}
