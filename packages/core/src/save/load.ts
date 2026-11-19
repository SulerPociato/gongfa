import type { Clock } from '../types';
import type { Program } from '../vm/program';
import type { GameState } from './schema';
import { readSave, type DecodeStage, type SaveStorage } from './storage';

// 空程序：verifier 认可的最小程序（契约 §4.1 的 HALT）。
// 降级装载用它，页面照常跑（只是这一 tick 什么都不做），玩家能重新搭。
export const EMPTY_PROGRAM: Program = { id: 'gongfa', code: [{ op: 'HALT' }] };

// 编译由宿主注入：core 不 import @gongfa/blocks，方向不能反（架构 §2.2）。
// errors 用 readonly：blocks 的编译结果就是只读数组，别逼宿主拷一遍。
export interface CompileResult {
  readonly ok: boolean;
  readonly program: Program | null;
  readonly errors: readonly string[];
}

export interface LoadOptions {
  storage: SaveStorage;
  clock: Clock;
  /** 用存档里的 workspace 重编译——IR 只是缓存，存档里的 programs 一律不读 */
  compile: (workspace: unknown) => CompileResult;
  /** 装载 = verifier 检查 + 交给 VM；返回问题清单，空数组代表成功 */
  install?: (program: Program) => readonly string[];
}

export type LoadStage = DecodeStage | 'compile' | 'install';

export interface LoadResult {
  ok: boolean;
  /** 没有存档可读（含坏档已清空），宿主该开新档 */
  fresh: boolean;
  /** 失败发生在固定六步的哪一步；成功为 null */
  stage: LoadStage | null;
  /** 硬失败：HUD 红字 */
  errors: readonly string[];
  /** 可继续但玩家该知道：回退备用槽、降级空程序 */
  notices: readonly string[];
  state: GameState | null;
  program: Program | null;
  fellBack: boolean;
  corruptedKey: string | null;
}

// 契约 §5.2 的固定顺序：读 envelope → 只取 schemaVersion → 连续迁移 → 结构+不变量校验
// → 重编译 workspace → 装载。前三步都在 decodeSave 里，失败会带出 stage。
export function loadGame(options: LoadOptions): LoadResult {
  const { storage, clock, compile, install } = options;
  const read = readSave(storage, clock);
  const notices = read.fellBack ? read.errors : [];

  if (read.save === null) {
    // 两槽都坏时 read.errors 已经写了「坏档已另存到 …」，玩家能自己去 localStorage 查改坏了哪儿
    return {
      ok: false,
      fresh: read.fresh,
      stage: read.stage,
      errors: read.fellBack ? [] : read.errors,
      notices,
      state: null,
      program: null,
      fellBack: read.fellBack,
      corruptedKey: read.corruptedKey,
    };
  }

  const state = read.save.state;
  const compiled = compile(state.workspace);
  if (!compiled.ok || compiled.program === null) {
    const errors = compiled.errors.length > 0 ? compiled.errors : ['workspace 无法编译'];
    // 降级：数值进度照旧装载，只把程序换成空的。白屏会让玩家以为整档没了，进而去清缓存——那才是真丢档。
    return {
      ok: false,
      fresh: false,
      stage: 'compile',
      errors,
      notices: ['功法已停用，按空程序运行；重新搭好后会自动存档。'],
      state,
      program: EMPTY_PROGRAM,
      fellBack: read.fellBack,
      corruptedKey: read.corruptedKey,
    };
  }

  const program = compiled.program;
  const installErrors = install === undefined ? [] : install(program);
  if (installErrors.length > 0) {
    return {
      ok: false,
      fresh: false,
      stage: 'install',
      errors: installErrors,
      notices,
      state,
      program,
      fellBack: read.fellBack,
      corruptedKey: read.corruptedKey,
    };
  }

  return {
    ok: true,
    fresh: false,
    stage: null,
    errors: [],
    notices,
    state,
    program,
    fellBack: read.fellBack,
    corruptedKey: read.corruptedKey,
  };
}
