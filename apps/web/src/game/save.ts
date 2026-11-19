import { SAVE_SCHEMA_VERSION, writeSave, type Clock, type GameState, type Program, type SaveFile, type SaveStorage } from '@gongfa/core';

// 自动存档三条腿：积木变更后 debounce 1s、离开页面立即写、平时 30s 兜一次。
// 30s 是崩溃保险：丢一次崩溃的代价远大于多写几次（浏览器配额按 gongfa: 前缀不到 100KB）。
export const AUTOSAVE_DEBOUNCE_MS = 1000;
export const AUTOSAVE_INTERVAL_MS = 30_000;

// 只有这些字段由运行时决定，其余（owned/equipped/speed/offlineRate/chargeReadyAt…）
// 以上一次成功落盘的 GameState 为基线原样带过去。
export interface SaveSnapshot {
  readonly workspace: unknown;
  /** 当前 workspace 编译出来的 IR 缓存；契约 §5.1 写而不读，所以每次落盘都要跟着换新版 */
  readonly programs: readonly Program[];
  readonly qi: number;
  readonly demon: number;
  readonly realm: number;
  readonly budgetPool: number;
  readonly totalQi: number;
  readonly breakthroughs: number;
  readonly playMs: number;
}

export interface SaveStatus {
  /** 非空即本次没写成，进 HUD 红字 */
  readonly messages: readonly string[];
  /** 最近一次成功落盘的时刻，用于 HUD 的「存档 HH:MM:SS」 */
  readonly savedAt: number | null;
}

export interface SaveController {
  /** 积木或数值变了：排一次 debounce */
  markDirty(): void;
  /** 立即落盘并回报状态 */
  flush(): SaveStatus;
  /** 挂生命周期监听，返回卸载函数 */
  attach(): () => void;
}

export function createSaveController(deps: {
  storage: SaveStorage;
  clock: Clock;
  base: GameState;
  getSnapshot: () => SaveSnapshot;
  onStatus?: ((status: SaveStatus) => void) | undefined;
}): SaveController {
  let state = deps.base;
  let timer = 0;

  const report = (status: SaveStatus): SaveStatus => {
    // 什么都没变也什么都没坏时不刷 HUD，免得存档提示一闪一闪
    if (deps.onStatus !== undefined && (status.messages.length > 0 || status.savedAt !== null)) deps.onStatus(status);
    return status;
  };

  const flush = (): SaveStatus => {
    if (timer !== 0) {
      window.clearTimeout(timer);
      timer = 0;
    }
    const snapshot = deps.getSnapshot();
    const now = deps.clock.now();
    const next: GameState = {
      ...state,
      workspace: snapshot.workspace,
      // programs 是编译缓存：每次都写当前这份，不能把读档带回来的旧缓存原样抄回去
      programs: [...snapshot.programs],
      // 契约 §5.1：qi / totalQi 是 BigNumber 的序列化字符串。这里一律 String()，
      // 不走 Qi.format（非整数会变成 3 位有效数字的科学计数，读回来就对不上了）。
      qi: String(snapshot.qi),
      demon: snapshot.demon,
      realm: snapshot.realm,
      budgetPool: snapshot.budgetPool,
      stats: { totalQi: String(snapshot.totalQi), breakthroughs: snapshot.breakthroughs, playMs: snapshot.playMs },
      lastSeenAt: now,
    };
    const save: SaveFile = { schemaVersion: SAVE_SCHEMA_VERSION, savedAt: now, state: next };
    const result = writeSave(deps.storage, save, deps.clock);
    // 写失败（超限 / 配额满 / 校验不过）时基线保持不动：下一轮仍然带着上一份好档的字段
    if (!result.ok) return report({ messages: result.errors, savedAt: null });
    state = next;
    return report({ messages: [], savedAt: now });
  };

  return {
    flush,
    markDirty() {
      if (timer !== 0) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        flush();
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    attach() {
      // 契约 §1：后台恢复走 visibilitychange。beforeunload 在 iOS Safari 上根本不触发，
      // 移动端也不可靠，所以用 pagehide + 隐藏时立即写。
      const onVisibility = (): void => {
        if (document.visibilityState === 'hidden') flush();
      };
      const onPageHide = (): void => {
        flush();
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', onPageHide);
      const interval = window.setInterval(flush, AUTOSAVE_INTERVAL_MS);
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        window.clearInterval(interval);
        if (timer !== 0) window.clearTimeout(timer);
        timer = 0;
      };
    },
  };
}
