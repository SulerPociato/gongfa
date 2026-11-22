import { describe, expect, it } from 'vitest';
import { blockLocalStorageWrites, createLocalStorageSaveStorage } from '../adapters/storage';
import { RESET_CONFIRM_TEXT, resetAllSaves } from './reset';

// 浏览器里没有 window/Storage 可给 vitest 的 node 环境用，这里搭一个最小实现：
// 只用 setItem / removeItem / key / length 这四件事，正好是存档适配器与清档逻辑用到的全部。
// log 记录每次落到 localStorage 的操作，用来验「谁先谁后」而不是靠读代码认顺序。
// 每次调用换一个全新的类：blockLocalStorageWrites 改的是原型，同一个类留到下一个用例
// 就把结论污染成「永远写不进」，那正是本节要证明的反面。
function makeFakeStorageClass(log: string[]) {
  return class FakeStorage {
    data = new Map<string, string>();
    get length(): number {
      return this.data.size;
    }
    key(index: number): string | null {
      return [...this.data.keys()][index] ?? null;
    }
    getItem(key: string): string | null {
      return this.data.has(key) ? (this.data.get(key) as string) : null;
    }
    setItem(key: string, value: string): void {
      log.push(`set:${key}`);
      this.data.set(key, value);
    }
    removeItem(key: string): void {
      log.push(`remove:${key}`);
      this.data.delete(key);
    }
  };
}

const OLD_SAVE = '{"schemaVersion":1,"savedAt":9,"state":{"qi":"123456"}}';
const KEYS = [
  ['gongfa:save:A', OLD_SAVE],
  ['gongfa:save:B', OLD_SAVE],
  ['gongfa:active', 'A'],
  ['gongfa:settings', '{"offlineBreakthrough":true}'],
  ['gongfa:tutorial', 'done'],
  ['gongfa:corrupted-9000', 'garbage{'],
  ['other-app:key', 'keep me'],
] as const;

function world() {
  const log: string[] = [];
  const FakeStorage = makeFakeStorageClass(log);
  const fake = new FakeStorage();
  globalThis.Storage = FakeStorage as unknown as typeof Storage;
  globalThis.window = { localStorage: fake } as unknown as typeof globalThis.window;
  for (const [key, value] of KEYS) fake.data.set(key, value);
  const storage = createLocalStorageSaveStorage();
  return { fake, log, storage, keys: () => [...fake.data.keys()].sort() };
}

describe('resetAllSaves', () => {
  it('清空 gongfa: 全部键（含 settings / tutorial / corrupted），别的命名空间不动', () => {
    const { storage, keys } = world();
    let reloaded = 0;
    expect(resetAllSaves({ storage, blockWrites: blockLocalStorageWrites, reload: () => (reloaded += 1) })).toBe(6);
    expect(reloaded).toBe(1);
    expect(keys()).toEqual(['other-app:key']);
  });

  it('先断写入、再清键、最后 reload', () => {
    const { storage, log } = world();
    resetAllSaves({
      storage,
      blockWrites: () => log.push('block'),
      reload: () => log.push('reload'),
    });
    expect(log[0]).toBe('block');
    expect(log.at(-1)).toBe('reload');
    expect(log.filter((line) => line.startsWith('remove:'))).toHaveLength(6);
  });

  it('阻断写入：清完之后模拟 pagehide 的 flush，旧档写不回来', () => {
    const { fake, log, storage, keys } = world();
    resetAllSaves({ storage, blockWrites: blockLocalStorageWrites, reload: () => {} });
    log.length = 0;
    // 这两行就是 flush → writeSave 落到 localStorage 的那一步
    storage.write('gongfa:save:A', OLD_SAVE);
    storage.write('gongfa:active', 'A');
    expect(log).toEqual([]);
    expect(keys()).toEqual(['other-app:key']);
    expect(fake.getItem('gongfa:save:A')).toBeNull();
  });

  it('对照组：不阻断时同样的写入会把旧档复活（说明上一条断言不是空转）', () => {
    const { storage, keys } = world();
    resetAllSaves({ storage, blockWrites: () => {}, reload: () => {} });
    storage.write('gongfa:save:A', OLD_SAVE);
    storage.write('gongfa:active', 'A');
    expect(keys()).toEqual(['gongfa:active', 'gongfa:save:A', 'other-app:key']);
  });

  it('确认框文案钉住', () => {
    expect(RESET_CONFIRM_TEXT).toBe('确定清空全部进度？灵力、境界、功法、道具都会没。');
  });
});
