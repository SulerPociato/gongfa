import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import {
  applyBacklash,
  BACKLASH_PAUSE_MS,
  BASE_BUDGET,
  bookSettleDeps,
  breakthrough as breakthroughRule,
  isThresholdReached,
  loadContent,
  makeActionSink,
  noiseGainMult,
  passivePerTick,
  Qi,
  reachesBacklash,
  Scheduler,
  TICKS_PER_SEC,
  Vm,
  type ActionRequest,
  type BookDef,
  type Clock,
  type GameState,
  type Program,
  type RealmDef,
  type SettleSink,
  type StallEvent,
  type TickResult,
  type VmSnapshot,
} from '@gongfa/core';
import { wallClock } from '../adapters/storage';

const content = loadContent({ actions: actionsJson, realms: realmsJson });

export interface RuntimeState {
  readonly qi: number;
  readonly demon: number;
  readonly rate: number;
  readonly ticks: number;
  readonly stall: StallEvent | null;
  /** 存档 §5.1 带回来的境界 id（新档从 realms.json 首行起，突破成功后 +1 档） */
  readonly realm: number;
  readonly seed: number;
  readonly budgetPool: number;
  readonly totalQi: number;
  readonly breakthroughs: number;
  readonly playMs: number;
  /** 当前境界名 / 突破阈值 / 被动产出：state() 从 realms.json 当前行现算，不会和表脱节。 */
  readonly realmName: string;
  readonly threshold: number;
  readonly passivePerSec: number;
  /** 存量 ≥ 当前境界阈值且还有下一境 → HUD 的「可渡劫」按钮亮。本轮没有渡劫挑战（任务 6.5 替换成蓄势+挑战）。 */
  readonly canBreakthrough: boolean;
  /** 走火入魔剩余毫秒：>0 表示惩罚期内不跑 tick、不计 playMs。不落盘（见 pausedUntil 的已知漏洞）。 */
  readonly pauseRemainingMs: number;
  /** VM 的 tick 计数（每会话从 0 起，存档里没这个字段），杂念与走火的 tick 号都按它对账。 */
  readonly tick: number;
  /** 最近 64 个杂念 / 走火入魔的 tick 号：验收和回放用，HUD 不显示。 */
  readonly noiseTicks: readonly number[];
  readonly backlashTicks: readonly number[];
  /** 当前装备的书 id（null = 未装备）。HUD 的按钮可见性看它，结算看下面三个乘数。 */
  readonly bookId: string | null;
  /** 结算真正吃进去的三个乘数：卸下或固化后必须回到中性（1 / 1 / 1），这是「成对移除」的可观察面。 */
  readonly bookDecay: number;
  readonly rateMult: number;
  readonly demonMult: number;
}

/**
 * 每次 state() 现算、不进可变状态的字段：境界四件套来自 realms.json 当前行，
 * 两个 tick 列表来自闭包里的数组（同一份引用交出去，debug 句柄读到的是实时值）。
 */
type DerivedField = 'realmName' | 'threshold' | 'passivePerSec' | 'canBreakthrough' | 'noiseTicks' | 'backlashTicks';

export interface Runtime {
  run(dtMs: number): TickResult[];
  /** 装载一份程序；返回错误列表（空数组表示成功）。失败时回退到上一份可用程序。 */
  load(program: Program): readonly string[];
  /** 用存档的数值状态覆盖运行时；返回内容表承接不了的项。 */
  restore(state: GameState): readonly string[];
  /** 装备或卸下（含固化）功法书：衰减与 modifiers 成对装卸。 */
  attachBook(book: BookDef | null): void;
  /** 简化突破：存量 ≥ 阈值就直接进下一境界（qi=0、demon=0，契约 §7.1）。返回拒绝原因，空数组 = 成功。 */
  breakthrough(): readonly string[];
  state(): RuntimeState;
}

// 开局默认值。seed 由 ?seed= 或真随机定（验收 5 要同种子复现），这里 0 是没查询参数时的起点。
const DEFAULTS: Omit<RuntimeState, 'stall' | DerivedField> = {
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
  pauseRemainingMs: 0,
  tick: 0,
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

// debug only：?seed=1 钉住随机序列，验收 5「同种子跑两次，杂念 tick 完全一致」靠它；正式 UI 不出现这个参数。
// 返回 null 表示查询串里没有，起点由宿主（App 掷 crypto）定；有存档时 restore() 覆盖它，存档优先。
// 先判 raw：Number(null) 是 0，直接 Number(...) 会把「没带参数」当成「带了 seed=0」——
// 任务 6 验收就是被这一行骗到，所有新档共用 seed 0 的杂念序列。
export function urlSeed(): number | null {
  const raw = new URLSearchParams(window.location.search).get('seed');
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value >>> 0 : null;
}

export interface RuntimeDeps {
  /**
   * 这一局的随机种子。新档由宿主掷一次 crypto，同时喂给 createRuntime 与 newGameState ——
   * 两边必须同一个值，否则落盘的 state.seed 描述的不是眼前跑的随机流
   * （runtime 先前固定用 ?seed= 否则 0，于是所有新档共用同一条杂念序列，刷新后才换）。
   */
  readonly seed?: number;
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
// 派生字段（境界四件套 + 两个事件列表）不在可变状态里，state() 每次现算。
type MutableState = { -readonly [K in keyof Omit<RuntimeState, DerivedField>]: RuntimeState[K] };

// 事件 tick 号只留最近 64 条：验收窗口 120 秒 = 1200 tick，全存下来没必要，长跑也不能把内存吃掉。
const EVENT_LOG_MAX = 64;

export function createRuntime(deps: RuntimeDeps = {}, clock: Clock = wallClock): Runtime {
  const state: MutableState = { ...DEFAULTS, demon: seedDemon(), seed: deps.seed ?? urlSeed() ?? 0, stall: null };
  const noiseTicks: number[] = [];
  const backlashTicks: number[] = [];
  const noteTick = (list: number[], tick: number): void => {
    list.push(tick);
    if (list.length > EVENT_LOG_MAX) list.shift();
  };
  // 走火入魔的 5 秒是墙钟 deadline（Q3）：按 tick 计数的话 2×/3× 倍速下惩罚只剩约 1.7 秒真实时间。
  // P0 已知漏洞：刷新可提前解除 5 秒惩罚，任务 8 接 schema v2 时一并落盘。
  let pausedUntil = 0;
  // sink 在构造时就把 realm.actionMult、书衰减与 modifiers 固定住了，境界或装备一变就要换一份。
  // 所以传给 VM 的是一层转发：attachBook / restore 之后新 sink 立刻生效，不用重建 VM。
  let realmIndex = indexOfRealm(seedRealm());
  state.realm = content.realms[realmIndex]?.id ?? 0;
  let currentBook: BookDef | null = null;
  let sink: SettleSink;

  // realmIndex 只由 indexOfRealm（找不到退回首行）和 breakthrough（下一行必然存在才返回成功）改，
  // 所以永远落在表内；realms.json 非空由 loadContent 保证。
  const currentRealm = (): RealmDef => content.realms[realmIndex] ?? content.realms[0]!;

  const realmView = (): Pick<RuntimeState, DerivedField> => {
    const realm = currentRealm();
    return {
      realmName: realm.name.zh,
      threshold: realm.threshold,
      passivePerSec: realm.passivePerSec,
      // 只看「存量够不够 + 还有没有下一境」；惩罚期由 HUD 用 pauseRemainingMs 置灰，runtime.breakthrough 再挡一次。
      canBreakthrough: isThresholdReached(state.qi, realm) && realmIndex + 1 < content.realms.length,
      noiseTicks,
      backlashTicks,
    };
  };

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
      const remaining = pausedUntil - clock.now();
      if (remaining > 0) {
        // 惩罚期：不跑 tick、不计 playMs（D3），accumulator 也清掉。
        // 必须 reset：攒着 dt 的话恢复瞬间 5 秒会排成 50 tick 突发，Scheduler 只补 MAX_CATCHUP_TICKS=5，
        // 剩下的转 onOverflowToOffline —— 任务 8 接上离线结算后，这段惩罚会被当成离线产出付钱，反向变成赚钱。
        scheduler.reset();
        state.pauseRemainingMs = remaining;
        return [];
      }
      state.pauseRemainingMs = 0;
      const results = scheduler.advance(dtMs);
      let processed = 0;
      for (const result of results) {
        processed += 1;
        state.tick = result.tick;
        // 杂念只砍程序产出 result.gain（D2）：契约 §2.3 把境界被动列为独立加法项，不参与这一刀。
        const mult = noiseGainMult({ demon: state.demon, seed: state.seed, tick: result.tick });
        if (mult < 1) noteTick(noiseTicks, result.tick);
        const gained = result.gain * mult + passivePerTick(currentRealm());
        state.qi += gained;
        state.rate = gained * TICKS_PER_SEC;
        state.ticks += 1;
        if (gained > 0) state.totalQi += gained;
        const demonBefore = state.demon;
        // 心魔夹在 0..1（契约 §1）；走火判据看夹紧之前的和，这一 tick 的账先记完再罚（01-design §4.4）。
        if (reachesBacklash(demonBefore, result.demonDelta)) {
          state.qi = applyBacklash(state.qi);
          state.demon = 0;
          pausedUntil = clock.now() + BACKLASH_PAUSE_MS;
          noteTick(backlashTicks, result.tick);
          // 本帧剩下的 tick 已经落进惩罚期，不再记账（记了就等于边罚边赚），accumulator 同理清零。
          scheduler.reset();
          break;
        }
        state.demon = Math.min(1, Math.max(0, demonBefore + result.demonDelta));
      }
      // playMs 只算在线操作时长（契约 §5.1），离线路由任务 8 单独累加。
      // 惩罚期内的帧在函数开头就 return 了；触发走火的那一帧最多多算一个 rAF（约 16 ms / 5000 ms）。
      state.playMs += Math.max(0, dtMs);
      state.pauseRemainingMs = Math.max(0, pausedUntil - clock.now());
      return results.slice(0, processed);
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
      // 每个会话的 tick 计数与事件列表从头开始（存档里没有它们），惩罚期也不跨会话带走。
      state.tick = 0;
      noiseTicks.length = 0;
      backlashTicks.length = 0;
      pausedUntil = 0;
      state.pauseRemainingMs = 0;
      // realms.json 现在有 4 行（炼气/筑基/金丹/元婴，契约 §2.3）：
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
    breakthrough: () => {
      if (pausedUntil > clock.now()) return [`走火入魔还剩 ${Math.ceil((pausedUntil - clock.now()) / 1000)} 秒，惩罚期内不能渡劫`];
      const outcome = breakthroughRule({ realms: content.realms, realmIndex, state: { qi: state.qi, demon: state.demon, realm: state.realm } });
      if (!outcome.ok) return outcome.errors;
      realmIndex = outcome.realmIndex;
      state.qi = outcome.state.qi;
      state.demon = outcome.state.demon;
      state.realm = outcome.state.realm;
      state.breakthroughs += 1;
      // 境界一变，sink 里的 actionMult 与书的衰减同时按新境界重算：只走 resetSink 这一个出口（Q2），
      // 书的 modifiers 原样带过去，不会渡个劫就把功法加成洗掉。
      resetSink();
      // 换境界不改时间轴：清掉攒下的 dt，免得下一帧把旧 accumulator 当成新境界的产出补跑。
      scheduler.reset();
      return [];
    },
    state: () => ({ ...state, ...realmView() }),
  };
}
