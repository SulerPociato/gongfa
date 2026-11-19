import { describe, expect, it } from 'vitest';
import type { Clock } from '../types';
import { newGameState, serializeSave, type SaveFile } from './schema';
import {
  ACTIVE_KEY,
  CORRUPTED_PREFIX,
  MAX_SAVE_CHARS,
  SLOT_KEYS,
  backupCorrupted,
  readSave,
  writeSave,
  type SaveStorage,
} from './storage';

interface FakeStorage extends SaveStorage {
  readonly ops: string[];
  dump(): Record<string, string>;
  /** 绕过 writeSave 直接污染某个 key，模拟玩家手改或半写坏档。 */
  corrupt(key: string, text: string): void;
  /** 让指定 key 的 write 返回 false，模拟配额满 / 隐私模式。 */
  failWritesFor(keys: readonly string[]): void;
}

function createFake(): FakeStorage {
  const map = new Map<string, string>();
  const ops: string[] = [];
  let failing: readonly string[] = [];
  return {
    ops,
    dump: () => Object.fromEntries(map),
    corrupt: (key, text) => {
      map.set(key, text);
      ops.push(`set:${key}`);
    },
    failWritesFor: (keys) => {
      failing = keys;
    },
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      ops.push(`write:${key}`);
      if (failing.includes(key)) return false;
      map.set(key, value);
      return true;
    },
    remove: (key) => {
      ops.push(`remove:${key}`);
      map.delete(key);
    },
    keys: () => [...map.keys()],
  };
}

const WORKSPACE = { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h' }] } };

function makeSave(savedAt: number, workspace: unknown = WORKSPACE): SaveFile {
  return { schemaVersion: 1, savedAt, state: newGameState({ seed: 7, workspace, now: savedAt }) };
}

function makeClock(start: number): { clock: Clock; set(value: number): void } {
  let now = start;
  return { clock: { now: () => now }, set: (value) => { now = value; } };
}

describe('双槽存档读写（契约 §5.2 第 4 步）', () => {
  it('首写只落 A 槽，指针最后才切到 A', () => {
    const storage = createFake();
    const { clock } = makeClock(1000);

    const result = writeSave(storage, makeSave(1000), clock);

    expect(result.ok).toBe(true);
    expect(result.slot).toBe('A');
    expect(result.bytes).toBe(serializeSave(makeSave(1000)).length);
    // 先写数据槽、后写指针：指针是唯一提交点，中途失败就还是旧档
    expect(storage.ops).toEqual([`write:${SLOT_KEYS[0]}`, `write:${ACTIVE_KEY}`]);
    expect(storage.read(ACTIVE_KEY)).toBe('A');
    expect(storage.read(SLOT_KEYS[1])).toBeNull();
  });

  it('二写先写备用槽 B，成功后才切指针；A 槽仍是上一份', () => {
    const storage = createFake();
    const { clock } = makeClock(1000);
    writeSave(storage, makeSave(1000), clock);
    const previousA = storage.read(SLOT_KEYS[0]);
    storage.ops.length = 0;

    const result = writeSave(storage, makeSave(2000), clock);

    expect(result.slot).toBe('B');
    expect(storage.ops).toEqual([`write:${SLOT_KEYS[1]}`, `write:${ACTIVE_KEY}`]);
    expect(storage.read(ACTIVE_KEY)).toBe('B');
    expect(storage.read(SLOT_KEYS[0])).toBe(previousA);
    expect(readSave(storage, clock).save?.savedAt).toBe(2000);
  });

  it('三写回到 A：槽位轮换 A→B→A', () => {
    const storage = createFake();
    const { clock } = makeClock(1000);
    writeSave(storage, makeSave(1000), clock);
    writeSave(storage, makeSave(2000), clock);
    storage.ops.length = 0;

    const result = writeSave(storage, makeSave(3000), clock);

    expect(result.slot).toBe('A');
    expect(storage.ops).toEqual([`write:${SLOT_KEYS[0]}`, `write:${ACTIVE_KEY}`]);
    expect(storage.read(ACTIVE_KEY)).toBe('A');
    expect(storage.read(SLOT_KEYS[0])).toContain('3000');
    expect(storage.read(SLOT_KEYS[1])).toContain('2000');
  });

  it('指针槽被改坏 → 回退备用槽，不做备份（还有一份能用）', () => {
    const storage = createFake();
    const { clock } = makeClock(1000);
    writeSave(storage, makeSave(1000), clock);
    writeSave(storage, makeSave(2000), clock);
    storage.corrupt(SLOT_KEYS[1], '{"schemaVersion":1,"savedAt":2000,"state":{"realm":99}}');

    const result = readSave(storage, clock);

    expect(result.ok).toBe(true);
    expect(result.fellBack).toBe(true);
    expect(result.save?.savedAt).toBe(1000);
    expect(result.corruptedKey).toBeNull();
    expect(result.errors.join(' ')).toContain('state.realm');
    // 界面只用这一句；上面的字段级明细是给宿主打日志的，不许拼进 summary
    expect(result.summary).toBe('主存档（B 槽）不可用，已回退 A 槽继续');
  });

  it('两槽都坏 → 坏档另存 corrupted-<ts>、清槽、开新档', () => {
    const storage = createFake();
    const { clock } = makeClock(5000);
    writeSave(storage, makeSave(1000), clock);
    writeSave(storage, makeSave(2000), clock);
    const brokenPrimary = 'garbage{';
    storage.corrupt(SLOT_KEYS[1], brokenPrimary);
    storage.corrupt(SLOT_KEYS[0], '{"schemaVersion":1,"savedAt":2000,"state":{}}');
    storage.ops.length = 0;

    const result = readSave(storage, clock);

    expect(result.ok).toBe(false);
    expect(result.fresh).toBe(true);
    expect(result.save).toBeNull();
    expect(result.stage).not.toBeNull();
    const corruptedKey = `${CORRUPTED_PREFIX}5000`;
    expect(result.corruptedKey).toBe(corruptedKey);
    expect(result.errors.join(' ')).toContain('两槽都校验失败');
    // 玩家看到的只有这一句，key 与下面实际写入的那个是同一个
    expect(result.summary).toBe(`存档已损坏，已备份为 ${corruptedKey}，已开新档`);
    // 备份的是主槽那份，坏档不丢；两个数据槽和指针都清空
    expect(storage.read(corruptedKey)).toBe(brokenPrimary);
    expect(storage.read(SLOT_KEYS[0])).toBeNull();
    expect(storage.read(SLOT_KEYS[1])).toBeNull();
    expect(storage.read(ACTIVE_KEY)).toBeNull();
  });

  it('同一时间戳再次损坏不覆盖旧备份，退到 -2', () => {
    const storage = createFake();

    const first = backupCorrupted(storage, 5000, 'bad-1');
    const second = backupCorrupted(storage, 5000, 'bad-2');

    expect(first).toBe(`${CORRUPTED_PREFIX}5000`);
    expect(second).toBe(`${CORRUPTED_PREFIX}5000-2`);
    expect(storage.read(first)).toBe('bad-1');
    expect(storage.read(second)).toBe('bad-2');
  });

  it('备用槽写失败（配额满）→ 不切指针，读回的还是上一份好档', () => {
    const storage = createFake();
    const { clock } = makeClock(1000);
    writeSave(storage, makeSave(1000), clock);
    storage.failWritesFor([SLOT_KEYS[1]]);

    const result = writeSave(storage, makeSave(2000), clock);

    expect(result.ok).toBe(false);
    expect(result.slot).toBeNull();
    expect(result.errors.join(' ')).toContain('写入失败');
    expect(storage.read(ACTIVE_KEY)).toBe('A');
    const read = readSave(storage, clock);
    expect(read.save?.savedAt).toBe(1000);
    expect(read.fellBack).toBe(false);
  });

  it('超过 MAX_SAVE_CHARS → 直接拒写，一个 key 都不碰（不能先删后报错）', () => {
    const storage = createFake();
    const { clock } = makeClock(1000);
    writeSave(storage, makeSave(1000), clock);
    const huge = makeSave(2000, { blob: 'x'.repeat(MAX_SAVE_CHARS) });
    storage.ops.length = 0;

    const result = writeSave(storage, huge, clock);

    expect(result.ok).toBe(false);
    expect(result.bytes).toBeGreaterThan(MAX_SAVE_CHARS);
    expect(result.errors.join(' ')).toContain('存档过大');
    expect(storage.ops).toEqual([]);
    expect(readSave(storage, clock).save?.savedAt).toBe(1000);
  });
});
