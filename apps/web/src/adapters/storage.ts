import type { SaveStorage } from '@gongfa/core';
import type { DemoFlagStore } from '../game/demo';

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

// 演示重置的一次性标记走 sessionStorage（任务 9 裁定 2）：要活过 reload，又不能落进 localStorage
// —— 那个槽是玩家的档，清档验收时「到底还剩几个键」必须只有存档一处来源。
// 存取全兜底：隐私模式下 sessionStorage 会直接抛，那会儿按「没有标记」处理，别连累整页启动。
export function createSessionFlagStore(): DemoFlagStore {
  const store = (): Storage | null => {
    try {
      return window.sessionStorage;
    } catch (error) {
      console.warn(`sessionStorage 不可用：${(error as Error).message}`);
      return null;
    }
  };
  return {
    read(key) {
      return store()?.getItem(key) ?? null;
    },
    write(key, value) {
      try {
        window.sessionStorage.setItem(key, value);
      } catch (error) {
        console.warn(`写入 ${key} 抛出：${(error as Error).message}`);
      }
    },
    remove(key) {
      try {
        window.sessionStorage.removeItem(key);
      } catch (error) {
        console.warn(`删除 ${key} 抛出：${(error as Error).message}`);
      }
    },
  };
}
