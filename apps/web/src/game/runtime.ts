import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import {
  BASE_BUDGET,
  bookSettleDeps,
  makeActionSink,
  Qi,
  Scheduler,
  TICKS_PER_SEC,
  Vm,
  loadContent,
  type ActionRequest,
  type BookDef,
  type GameState,
  type Program,
  type SettleSink,
  type StallEvent,
  type TickResult,
  type VmSnapshot,
} from '@gongfa/core';

const content = loadContent({ actions: actionsJson, realms: realmsJson });

export interface RuntimeState {
  readonly qi: number;
  readonly demon: number;
  readonly rate: number;
  readonly ticks: number;
  readonly stall: StallEvent | null;
  /** 存档 §5.1 带回来的运行期状态；P0 的存档路径不推进境界（突破在任务 6.5） */
  readonly realm: number;
  readonly seed: number;
  readonly budgetPool: number;
  readonly totalQi: number;
  readonly breakthroughs: number;
  readonly playMs: number;
  /** 当前装备的书 id（null = 未装备）。HUD 的按钮可见性看它，结算看下面三个乘数。 */
  readonly bookId: string | null;
  /** 结算真正吃进去的三个乘数：卸下或固化后必须回到中性（1 / 1 / 1），这是「成对移除」的可观察面。 */
  readonly bookDecay: number;
  readonly rateMult: number;
  readonly demonMult: number;
}

export interface Runtime {
  run(dtMs: number): TickResult[];
  /** 装载一份程序；返回错误列表（空数组表示成功）。失败时回退到上一份可用程序。 */
  load(program: Program): readonly string[];
  /** 用存档的数值状态覆盖运行时；返回内容表承接不了的项。 */
  restore(state: GameState): readonly string[];
  /** 装备或卸下（含固化）功法书：衰减与 modifiers 成对装卸。 */
  attachBook(book: BookDef | null): void;
  state(): RuntimeState;
}

// 开局默认值。seed 由宿主生成真随机 uint32，这里只是 VM 还没被 restore 时的占位。
const DEFAULTS: Omit<RuntimeState, 'stall'> = {
  qi: 0,
  demon: 0,
  rate: 0,
  ticks: 0,
  realm: 0,
  seed: 0,
  budgetPool: BASE_BUDGET,
  totalQi: 0,
  breakthroughs: 0,
  playMs: 0,
  bookId: null,
  bookDecay: 1,
  rateMult: 1,
  demonMult: 1,
};

// debug only：?demon=0.49 把心魔种子挪到 0.5 附近，方便当场看分支切换；正式 UI 不出现这个参数。
// 有存档时 restore() 会覆盖它，存档优先。
function seedDemon(): number {
  const raw = Number(new URLSearchParams(window.location.search).get('demon'));
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

// debug only：?realm=1 把境界挪到筑基，当场看衰减（§2.2）与境界乘数（§2.1）；正式 UI 不出现这个参数。
function seedRealm(): number {
  const raw = Number(new URLSearchParams(window.location.search).get('realm'));
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

// 境界 id → realms.json 下标。表里没有就不静默：退回首境并说明，宁可少算也不拿 undefined 当乘数。
function indexOfRealm(id: number): number {
  const index = content.realms.findIndex((realm) => realm.id === id);
  if (index < 0) {
    console.warn(`[境界] 表里没有 id ${id}（现有 ${content.realms.map((realm) => realm.id).join('/')}），先按境界 ${content.realms[0]?.id ?? 0} 算`);
    return 0;
  }
  return index;
}

// RuntimeState 对外只读，内部要逐 tick 累加，所以剥掉 readonly 另建一份可变类型。
type MutableState = { -readonly [K in keyof RuntimeState]: RuntimeState[K] };

export function createRuntime(): Runtime {
  const state: MutableState = { ...DEFAULTS, demon: seedDemon(), stall: null };
  // sink 在构造时就把 realm.actionMult、书衰减与 modifiers 固定住了，境界或装备一变就要换一份。
  // 所以传给 VM 的是一层转发：attachBook / restore 之后新 sink 立刻生效，不用重建 VM。
  let realmIndex = indexOfRealm(seedRealm());
  state.realm = content.realms[realmIndex]?.id ?? 0;
  let currentBook: BookDef | null = null;
  let sink: SettleSink;

  // 唯一的 sink 出口：衰减（§2.2）与 modifiers（§4）都从 bookSettleDeps 成对进出，
  // 卸下或固化时传 null 就得到完全中性的 1 / []，不可能只剩一半。
  const resetSink = (): void => {
    sink = makeActionSink({ content, realmIndex, ...bookSettleDeps(currentBook, state.realm) });
    state.bookId = currentBook?.id ?? null;
    state.bookDecay = sink.mults.bookDecay;
    state.rateMult = sink.mults.rateMult;
    state.demonMult = sink.mults.demonMult;
  };
  resetSink();

  const vm = new Vm({
    content,
    sink: {
      execute: (request: ActionRequest) => sink.execute(request),
    },
    // VM 每 tick 开头读一次快照：宿主的 qi / demon 在这里进 LOAD，分支判断用的就是本 tick 起点的最新值。
    vars: (): VmSnapshot => ({ qi: state.qi, rate: state.rate, demon: state.demon, realm: state.realm, budget: state.budgetPool }),
    onEvent: (event) => {
      if (event.t === 'stall') state.stall = event;
      console.warn('[event]', event);
    },
  });
  const scheduler = new Scheduler({
    vm,
    // 契约 §1：单帧最多补 5 tick，剩余转离线结算（任务 8 接入），这里只报告，不静默快进。
    onOverflowToOffline: (pendingMs) => console.warn(`[补帧溢出] 未补 ${Math.round(pendingMs)} ms，转离线结算`),
  });
  let lastGood: Program | null = null;

  return {
    run: (dtMs) => {
      const results = scheduler.advance(dtMs);
      for (const result of results) {
        state.qi += result.gain;
        // 心魔夹在 0..1；demon ≥ 1 的走火入魔惩罚（qi ×0.7、心魔归 0）在任务 6 实现，本轮只涨不罚。
        state.demon = Math.min(1, Math.max(0, state.demon + result.demonDelta));
        state.rate = result.gain * TICKS_PER_SEC;
        state.ticks += 1;
        if (result.gain > 0) state.totalQi += result.gain;
      }
      // playMs 只算在线操作时长（契约 §5.1），离线路由任务 8 单独累加
      state.playMs += Math.max(0, dtMs);
      return results;
    },
    load: (program) => {
      const result = vm.loadPrograms([program]);
      if (!result.ok) {
        // VM 装载失败会清空已装程序，这里保留上一份可用程序是为了不让数字停住，不是 VM 的 bug。
        if (lastGood !== null) vm.loadPrograms([lastGood]);
        return result.errors.map((issue) => issue.message);
      }
      lastGood = program;
      // 装上一份合法程序即认为故障已排除，旧的 stall 不该继续挂在 HUD 上。
      state.stall = null;
      return [];
    },
    restore: (saved) => {
      const errors: string[] = [];
      // 契约 §5.1 把 qi / totalQi 存成字符串，读回来一律走 Qi.parse（校验层已挡掉 NaN）
      state.qi = Qi.parse(saved.qi);
      state.totalQi = Qi.parse(saved.stats.totalQi);
      state.demon = Math.min(1, Math.max(0, saved.demon));
      state.seed = saved.seed;
      state.budgetPool = saved.budgetPool;
      state.breakthroughs = saved.stats.breakthroughs;
      state.playMs = saved.stats.playMs;
      // realms.json 目前只有炼气（突破在任务 6.5 才写境界表）：
      // 存档里的境界没有对应产出表时明说，不静默用炼气的乘数算出个偏低速率。
      const index = content.realms.findIndex((realm) => realm.id === saved.realm);
      const fallback = index < 0;
      realmIndex = fallback ? 0 : index;
      state.realm = content.realms[realmIndex]?.id ?? 0;
      // 装备位由宿主在 restore 之后 attachBook 回来（runtime 不查目录）：这里先清成中性，
      // 免得上一份会话的书衰减残留在 sink 里。
      currentBook = null;
      resetSink();
      if (fallback) {
        errors.push(`存档境界 ${saved.realm} 在 content/realms.json 里还没有产出表（现有 ${content.realms.map((realm) => realm.id).join('/')}），先按境界 ${state.realm} 算`);
      }
      return errors;
    },
    attachBook: (book) => {
      currentBook = book;
      resetSink();
    },
    state: () => ({ ...state }),
  };
}
