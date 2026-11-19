import type { SaveStorage } from '@gongfa/core';

// core 只认 keyed 端口（架构 §2.6），localStorage 的坑在这里挡掉：
// 读失败返回 null、写失败返回 false，一律不外抛——配额满或隐私模式不该让整页崩。
// 键名由 core 决定（gongfa:save:A / gongfa:active / gongfa:corrupted-<ts>），这里不再叠加前缀，
// 这样验收时可以直接在 devtools 里改 localStorage['gongfa:save:A']。
const NAMESPACE = 'gongfa:';

function available(): Storage | null {
  try {
    return window.localStorage;
  } catch (error) {
    console.warn(`localStorage 不可用：${(error as Error).message}`);
    return null;
  }
}

export function createLocalStorageSaveStorage(): SaveStorage {
  return {
    read(key) {
      try {
        return window.localStorage.getItem(key);
      } catch (error) {
        console.warn(`读取 ${key} 抛出：${(error as Error).message}`);
        return null;
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(key, value);
        return true;
      } catch (error) {
        // 最常见的是 QuotaExceededError：交给 writeSave 走「不切指针、保留上一份」的分支
        console.warn(`写入 ${key} 抛出：${(error as Error).message}`);
        return false;
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch (error) {
        console.warn(`删除 ${key} 抛出：${(error as Error).message}`);
      }
    },
    keys() {
      const store = available();
      if (store === null) return [];
      const out: string[] = [];
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key !== null && key.startsWith(NAMESPACE)) out.push(key);
      }
      return out;
    },
  };
}

export const wallClock = { now: () => Date.now() };
