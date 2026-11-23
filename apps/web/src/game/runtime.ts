import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import {
  CHALLENGE_COOLDOWN_MS,
  CHALLENGE_TRIAL_MS,
  CHARGE_WINDOW_MS,
  applyBacklash,
  armCharge,
  AWAY_FRAME_BUDGET_MS,
  BACKLASH_PAUSE_MS,
  BASE_BUDGET,
  bookSettleDeps,
  chargeRemainingMs,
  demonlessSink,
  isChargeReady,
  isThresholdReached,
  loadContent,
  makeActionSink,
  MAX_CATCHUP_TICKS,
  noiseGainMult,
  passivePerTick,
  planAwayResume,
  previewCurve,
  Qi,
  reachesBacklash,
  resolveChallenge,
  Scheduler,
  settleOfflineIfAway,
  shiftChargeReadyAt,
  SprintWindow,
  sprintGoalQi,
  halveChargeWindowMs,
  SPRINT_WINDOW_MS,
  TICK_MS,
  TICKS_PER_SEC,
  Vm,
  DEMON_BASE_PER_ACTION,
  type ActionRequest,
  type ArtifactEquipment,
  type BookDef,
  type ChallengeMode,
  type Clock,
  type CurvePreview,
  type GameState,
  type JadeCacheSpec,
  type Modifier,
  type OfflineResult,
  type Program,
  type RealmDef,
  type SettleSink,
  type StallEvent,
  type TickResult,
  type VmSnapshot,
} from '@gongfa/core';
import { wallClock } from '../adapters/storage';
import { demoJumpTarget, demoSpeed, type DemoJumpTarget } from './demo';

const content = loadContent({ actions: actionsJson, realms: realmsJson });

/**
 * 调息每次压掉多少心魔：直接取 actions.json 里 calm 那行的 demonDelta（任务 8 P0-C 第 6 项）。
 * 表里没有调息就给 null —— 面板宁可不说这句，也不要印一个「-0/次」假装压得住。
 * 走模块常量而不是 RuntimeState：它和 VM 吃的是同一份 content，逐帧现算只会多一次查表。
 */
export const CALM_DEMON_DELTA: number | null = content.actions.find((action) => action.id === 'calm')?.demonDelta ?? null;

export interface RuntimeState {
  readonly qi: number;
  readonly demon: number;
  readonly rate: number;
  readonly ticks: number;
  readonly stall: StallEvent | null;
  /**
   * 本 tick 实际执行的指令数（批次 5：步数经济学）。
   * 与 budgetPool 一起构成「效率 = 每 tick 产出 ÷ 步数」，让玩家能看见"多算一遍"的代价；
   * 0 = 没有程序在跑（空画布/编译失败），不是"程序 0 步"。
   */
  readonly stepsThisTick: number;
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
  /**
   * 存量 ≥ 当前境界阈值且还有下一境 → 「可冲关」的前半条件（后半是蓄势就绪，见 canChallenge）。
   * 名字里的「可」是「现在能发起一次冲关」，不是「境界已经变了」：境界只在 settle() 成功那一支 +1，
   * 光看到这个 true 而不动数字才是对的。
   */
  readonly canBreakthrough: boolean;
  /**
   * 蓄势完成时刻（契约 §5.1 的 chargeReadyAt，真实时间毫秒）：0 = 本境界从未达标。
   * 这是落盘字段：每次 arm 出非零值都要标脏，否则浏览器刷新后会重新等 2 分钟。
   */
  readonly chargeReadyAt: number;
  /** 本境界内第几次渡劫（§7.1 的 N，从 1 起）：只活内存，刷新回到 1 = 「连续失败」清零。 */
  readonly attempt: number;
  /** 本档悟道（§7.1「不入档，刷新清零」）：每次渡劫失败 +1。 */
  readonly insight: number;
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
  /** 蓄势还要等的真实毫秒：chargeReadyAt 为 0（从未达标）时也是 0，靠 canChallenge 区分。 */
  readonly chargeRemainingMs: number;
  /** 存量达标 + 有下一境 + 蓄势已就绪 + 不在冷却 → 「可渡劫」按钮真的能点（HUD 的 disabled 只看这个）。 */
  readonly canChallenge: boolean;
  /** 10 秒挑战进行中：按钮文案切成「立即冲关（手动 85%）」，画布同时提示「改功法只改接下来的产出」。 */
  readonly challengeActive: boolean;
  /** 挑战剩余毫秒：0 = 不在挑战中。 */
  readonly trialRemainingMs: number;
  /** 渡劫冷却剩余毫秒：0 = 可以开始下一次。 */
  readonly cooldownRemainingMs: number;
  /** realms.json 的下标（境界 id 在表里的位置）：工具箱门控与蓄势窗口都按它取，不假设 id 连续。 */
  readonly realmIndex: number;
  /** 下一境的名字，末境是 null：HUD 据此区分「还差存量」与「已到顶」，也用来写「渡劫 → 金丹」。 */
  readonly nextRealmName: string | null;
  /** ?demo=1：跳过蓄势与 10 秒，HUD 要写明当前是演示模式。 */
  readonly demo: boolean;
  /**
   * 试炼（契约 §7.1.1）：本境界 60 秒滑动窗口的目标产出。
   * 表里没有这一行时给 null，HUD 整行不显示——画一条「/0」的假进度比不画更糟。
   */
  readonly sprintGoalQi: number | null;
  /** 当前 60 秒窗口内已产出（含境界被动，与 HUD 的「/ 秒」同口径）。 */
  readonly sprintProgressQi: number;
  /** 窗口长度（毫秒）：HUD 写「/60秒」用的是这个数，不自己写死 60。 */
  readonly sprintWindowMs: number;
  /** 本境界是否已拿到「蓄势减半」：换境界后回到 false（§7.1.1 只生效一次、不可叠加）。 */
  readonly sprintReached: boolean;
  /** 批次 7：当前道途（null = 还没选）。元进度，不入档。 */
  readonly dao: DaoPath | null;
  /** 批次 8：灵根名（由 seed 派生，只影响心魔增速）。 */
  readonly lingGen: string;
  /** 批次 8：丹药冷却剩余毫秒（>0 时按钮置灰）。 */
  readonly pillCooldownMs: number;
  /** 同一 60 秒窗口内累计执行的指令数（批次 6：试炼评分）。0 = 没有程序在跑。 */
  readonly sprintSteps: number;
  /** 窗口内「每步换多少灵力」= sprintProgressQi / sprintSteps；0 步时为 0。 */
  readonly sprintPerQi: number;
  /**
   * 最近一次「结算」（10 秒到点的托管、挑战中的手动确认、演示模式的当场结算都算，拒绝也算）：
   * 托管那一发是 run() 里结算的，没有按钮可挂回调，所以结果放在状态里由宿主逐帧观察，
   * 否则玩家只看见数字跳了一下，不知道这局是成是败、骰了多少。
   */
  readonly lastChallenge: ChallengeResult | null;
}

/**
 * 每次 state() 现算、不进可变状态的字段：境界四件套来自 realms.json 当前行，
 * 两个 tick 列表来自闭包里的数组（同一份引用交出去，debug 句柄读到的是实时值），
 * 渡劫这几件套是把闭包里的墙钟 deadline 换算成剩余毫秒。
 */
type DerivedField =
  | 'realmName' | 'threshold' | 'passivePerSec' | 'canBreakthrough' | 'noiseTicks' | 'backlashTicks' | 'realmIndex' | 'nextRealmName'
  | 'chargeRemainingMs' | 'canChallenge' | 'challengeActive' | 'trialRemainingMs' | 'cooldownRemainingMs' | 'demo'
  | 'sprintGoalQi' | 'sprintProgressQi' | 'sprintWindowMs' | 'sprintReached' | 'sprintSteps' | 'sprintPerQi'
  | 'dao' | 'lingGen' | 'pillCooldownMs';

/**
 * 一次「点按钮」的去向：什么都没开始（拒绝，按钮前置条件没满足）/ 10 秒开始走 / 真结算出成败 /
 * 已开始但结算被拒（挑战中存量掉回阈值下，§7.1「渡劫无从开始」）。后两类都要在 HUD 上说出来。
 */
export interface ChallengeResult {
  readonly errors: readonly string[];
  readonly phase: 'idle' | 'trial' | 'refused' | 'settled';
  readonly ok: boolean;
  readonly mode: ChallengeMode | null;
  /** 结算时用的是本境界第几次（§7.1 的 N）；未结算时为下一次将要用的 N。 */
  readonly attempt: number;
  readonly rate: number;
  readonly roll: number;
  /** 第 3 次的成功来自保底而非骰子（§7.1）：HUD 要区分「渡劫成功」与「保底功成」。 */
  readonly forced: boolean;
  readonly qi: number;
  readonly realmName: string;
  /**
   * 结算开始前所在的境界。`realmName` 是结算后的那一境，成功时两者差一境，
   * 结果层的副标「炼气 → 筑基」要的是这一对，让 UI 回头查表就是第二份口径。
   */
  readonly fromRealmName: string;
}

/** 跳关的可观察面：境界、存量、该行阈值一起交出去，验收和 toast 都读它，不用调用方再查一遍表。 */
export interface DemoJumpResult extends DemoJumpTarget {
  readonly threshold: number;
}

export interface Runtime {
  run(dtMs: number): TickResult[];  /** 装载一份程序；返回错误列表（空数组表示成功）。失败时回退到上一份可用程序。 */
  load(program: Program): readonly string[];
  /** 用存档的数值状态覆盖运行时；返回内容表承接不了的项。 */
  restore(state: GameState): readonly string[];
  /** 装备或卸下（含固化）功法书：衰减与 modifiers 成对装卸。 */
  attachBook(book: BookDef | null): void;
  /**
   * 装备或卸下道具（契约 §2.4，任务 7A）：与 attachBook 同一套成对装卸 ——
   * 玉简换 sink（命中折扣与免步都取自规格本身），算盘换 VM 的预算池。
   * 传全中性（jadeCache: null、budgetBonus: 0）就是两件都卸下。
   */
  attachArtifacts(equipment: Pick<ArtifactEquipment, 'jadeCache' | 'budgetBonus' | 'modifiers'>): void;
  /**
   * 「可渡劫」按钮的唯一入口（契约 §7.1）：蓄势就绪时开启 10 秒挑战，挑战中再点一次按 mode 当场结算，
   * 放手到点则由 run() 按托管 60% 自动结算。mode 默认 'manual'（85%），「交给天意」传 'auto'。
   * 拒绝原因在 errors 里，空数组 = 这次点击被接受。
   */
  pressChallenge(mode?: ChallengeMode): ChallengeResult;
  /**
   * 演示跳关（任务 9，裁定 1）：一站落到「下一境＝元婴」的那一境（金丹），存量给到该行阈值的 95%。
   * 只在 ?demo=1 下可用，且落点全部从 realms.json 现算；返回 null = 这次跳不了（非演示模式，
   * 或表里根本没有元婴那一行），不静默退回首境。
   */
  jumpToDemoTarget(): DemoJumpResult | null;
  /**
   * 选道途（批次 7）。一次定终身：重复调用只会覆盖当前会话，宿主负责只让玩家选一次。
   * 会重建 sink —— 邪修的代价是 demonBase，而 sink 在构造时就把 demonBase 固定了。
   */
  setDao(path: DaoPath): void;
  /**
   * 服丹（批次 8）：存量 ×5% 换心魔 -0.15，30 秒冷却。
   * 存在的理由：心魔是唯一风险系统，而"调息"只压不换；丹药让存量从"只用来突破"
   * 变成一种可花的资源，也给入魔的高增速一个可对冲的手段。
   */
  takePill(): { readonly ok: boolean; readonly reason?: string };
  /**
   * 离线结算入口（任务 7B，契约 §7.2）：快进指定时长的 tick，按 0.6 折算入账，
   * 期间心魔不涨、杂念不砍、走火不罚。返回结算结果（null = 没跑，例如 0 tick）。
   */
  settleOffline(input: { readonly lastSeenAt: number; readonly allowBreakthrough: boolean }): OfflineResult | null;
  /**
   * 曲线预览（任务 8 P0-B，架构 §曲线预览）：简化模型估这份程序 60 秒能攒多少，不启动 VM。
   * 表与预算池都从 runtime 现取，宿主再 loadContent 一份就是第二套口径；编译失败传 null 就什么都不画。
   */
  preview(program: Program | null): CurvePreview | null;
  state(): RuntimeState;
}

// 开局默认值。seed 由 ?seed= 或真随机定（验收 5 要同种子复现），这里 0 是没查询参数时的起点。
const DEFAULTS: Omit<RuntimeState, 'stall' | 'stepsThisTick' | DerivedField> = {
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
  chargeReadyAt: 0,
  attempt: 1,
  insight: 0,
  pauseRemainingMs: 0,
  tick: 0,
  bookId: null,
  bookDecay: 1,
  rateMult: 1,
  demonMult: 1,
  lastChallenge: null,
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

export type DaoPath = 'orthodox' | 'heretic';

export interface RuntimeDeps {
  /**
   * 道途（批次 7）：元进度，不进 GameState（不入档）。
   * null = 还没选；'orthodox' 守正 = 全产出 +8%；'heretic' 入魔 = 全产出 +20%、心魔基础增速 +40%。
   * 代价刻意放在 demonBase 上而不是 demonMult：后者会把调息的减量一起放大。
   */
  readonly dao?: DaoPath | null;
  /**
   * 这一局的随机种子。新档由宿主掷一次 crypto，同时喂给 createRuntime 与 newGameState ——
   * 两边必须同一个值，否则落盘的 state.seed 描述的不是眼前跑的随机流
   * （runtime 先前固定用 ?seed= 否则 0，于是所有新档共用同一条杂念序列，刷新后才换）。
   */
  readonly seed?: number;
  /**
   * 「有字段要落盘了」的通知。runtime 不认存档控制器（构造时控制器还没建），宿主给一个闭包就行。
   * 渡劫结算与蓄势起算都会调它：chargeReadyAt 是 §5.1 的存档字段，漏标一次刷新就重新等 2 分钟。
   */
  readonly markDirty?: (() => void) | undefined;
  /**
   * 离线渡劫开关（契约 §7.2 / 设置项 offlineBreakthrough）。用懒调用而不是值：
   * runtime 在 render 期构造，那时 settings 的 state 还没定；切标签页回来这一支才读得到当前值。
   */
  readonly allowBreakthrough?: (() => boolean) | undefined;
  /**
   * 空窗 ≥60 秒走了离线公式之后，把结果交给宿主弹「闭关报告」（任务 7B 那个面板）。
   * 只在后台恢复路径回调：boot 路径的报告由 App 自己塞 hudModel，两条共用同一个转换函数。
   */
  readonly onOfflineReport?: ((result: OfflineResult) => void) | undefined;
}

// 演示模式（01-design §十 / 契约 §7.3「演示模式可跳过蓄势」）：?demo=1 开，
// 蓄势窗口与 10 秒挑战一起跳过（直接按手动 85% 结算），工具箱也全开。
// 值为 0 / false 视为不开，方便评审用 ?demo=0 对照正式玩法。
export function urlDemo(): boolean {
  const raw = new URLSearchParams(window.location.search).get('demo');
  return raw !== null && raw !== '0' && raw.toLowerCase() !== 'false';
}

// debug only：?debug=1 且 ?charge=0 时把蓄势窗口强行设成 0（立刻可冲关），当场验 2/5 分钟的算术。
// 和 ?demo=1 分开：演示模式是一揽子开关，这个只动蓄势，心魔、杂念、离线照旧。
function chargeSkipped(): boolean {
  const query = new URLSearchParams(window.location.search);
  return query.has('debug') && query.get('charge') === '0';
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
  const state: MutableState = { ...DEFAULTS, demon: seedDemon(), seed: deps.seed ?? urlSeed() ?? 0, stall: null, stepsThisTick: 0 };

  // 道途（批次 7）：只影响两处 —— 全产出倍率、心魔基础增速。
  // dao 变化必须重建 sink：demonBase 在 makeActionSink 构造时就固定了。
  let dao: DaoPath | null = deps.dao ?? null;
  const daoRate = (path: DaoPath | null): number => (path === 'orthodox' ? 1.08 : path === 'heretic' ? 1.12 : 1);
  // 灵根（批次 8）：seed 派生，只影响心魔增速（×0.9/1.0/1.1），不动产出 ——
  // 动产出会把 11:09 目标表一起改掉，而它是"命格"不是"数值档位"。
  const lingGenIndex = (state.seed >>> 0) % 3;
  const lingGenName = ['上品灵根', '中品灵根', '下品灵根'][lingGenIndex] ?? '中品灵根';
  const lingGenDemon = [0.9, 1, 1.1][lingGenIndex] ?? 1;
  const demonBaseOf = (path: DaoPath | null): number => DEMON_BASE_PER_ACTION * (path === 'heretic' ? 2 : 1) * lingGenDemon;
  // 丹药冷却（批次 8）：墙钟，不按 tick —— 倍速下不该变成 30/3 秒。
  const PILL_COOLDOWN_MS = 30_000;
  let pillReadyAt = 0;
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
  // 玉简的规格和书一样是「装上去就固定进 sink」的事实，卸下即 null；预算池另存在 VM 里，见 attachArtifacts。
  let currentJadeCache: JadeCacheSpec | null = null;
  // 道具提供的通用修正（rate / demonRate）：每次 attachArtifacts 整体替换，卸下即空数组。
  let artifactModifiers: readonly Modifier[] = [];
  let sink: SettleSink;
  // 离线快进期间要静音事件（36 000 条 stall 会刷爆控制台），用这个标志位控制 onEvent
  let offlineQuiet = false;
  // demonlessSink 的包装实例：构造一次，离线期间通过 offlineQuiet 切换是否走它
  const offlineWrapper = demonlessSink(() => sink);

  // realmIndex 只由 indexOfRealm（找不到退回首行）和渡劫成功（下一行必然存在才返回成功）改，
  // 所以永远落在表内；realms.json 非空由 loadContent 保证。
  const currentRealm = (): RealmDef => content.realms[realmIndex] ?? content.realms[0]!;
  const demoMode = urlDemo();
  const markDirty = deps.markDirty ?? (() => undefined);

  // 渡劫的两个墙钟 deadline。P0 已知漏洞：attempt / insight / trialUntil / cooldownUntil 只在内存里，
  // 刷新即清零 —— §7.1 的「同一境界连续 3 次必成」与「渡劫后 60 秒冷却」因此都能被刷新绕过。
  // 契约 §5.1 没有对应字段，任务 8 造 schema v2 时一并落盘；HUD 的文案必须写明「刷新清零」。
  // 只有 chargeReadyAt（§5.1 现成字段）落盘，蓄势这条时间墙跨刷新继续。
  let trialUntil = 0;
  let cooldownUntil = 0;

  // 试炼（契约 §7.1.1）：60 秒滑动窗口只统计在线逐 tick 产出，达成一次就把本境界正在等的蓄势窗口减半。
  // sprintReachedRealm 记的是「哪一境拿到过减半」，所以下标相等才算已达成：换境后自然失效，
  // 一条比较同时管住「只生效一次」与「不可叠加」。与 attempt / insight 同族：只在内存、刷新重置、不入档。
  const sprint = new SprintWindow();
  // 试炼效率（批次 6）：和产出窗口同长度的一条步数环，用来算「每步换多少灵力」。
  // 单独记的原因：SprintWindow 存的是 Qi，步数是普通计数，混在一起会把 BigInt 语义带进 UI。
  const sprintStepCells: number[] = new Array<number>(sprint.capacityTicks).fill(0);
  let sprintStepCursor = 0;
  let sprintStepSum = 0;
  const pushSprintSteps = (steps: number): void => {
    const evicted = sprintStepCells[sprintStepCursor] ?? 0;
    sprintStepCells[sprintStepCursor] = steps;
    sprintStepSum = sprintStepSum - evicted + steps;
    sprintStepCursor = (sprintStepCursor + 1) % sprint.capacityTicks;
  };
  const resetSprintSteps = (): void => {
    sprintStepCells.fill(0);
    sprintStepCursor = 0;
    sprintStepSum = 0;
  };
  let sprintReachedRealm: number | null = null;

  // 宿主策略决定窗口：演示模式与 ?charge=0 把窗口设成 0，核心只做「首次达标 + 窗口」这一条加法。
  // 窗口按【目标境界】下标取：筑基存量首次达标要冲的是金丹 → CHARGE_WINDOW_MS[realmIndex + 1]。
  // 离线快进要按它自己推进到的境界问一遍（realmIdx 由 core 传进来），不能沿用当前境的判断。
  const chargeWindowFor = (index: number): number =>
    halveChargeWindowMs(demoMode || chargeSkipped() ? 0 : CHARGE_WINDOW_MS[index + 1] ?? 0, sprintReachedRealm === index);
  const chargeWindowMs = (): number => chargeWindowFor(realmIndex);
  // 试炼是在「已经 arm 出整窗完成时刻」之后才达成时，要前移的是那个整窗的一半，
  // 所以这里另开一个不减半的口径：拿 chargeWindowMs() 自己的一半去挪，等于把半窗再砍一次。
  const fullChargeWindowMs = (): number => (demoMode || chargeSkipped() ? 0 : CHARGE_WINDOW_MS[realmIndex + 1] ?? 0);

  const realmView = (): Pick<RuntimeState, DerivedField> => {
    const realm = currentRealm();
    const next = content.realms[realmIndex + 1];
    const now = clock.now();
    const thresholdReached = isThresholdReached(state.qi, realm);
    const active = trialUntil > now;
    return {
      realmName: realm.name.zh,
      nextRealmName: next?.name.zh ?? null,
      threshold: realm.threshold,
      passivePerSec: realm.passivePerSec,
      realmIndex,
      // 「可冲关」的前半：够存量、还有下一境。惩罚与冷却由 canChallenge 和 pressChallenge 兜底。
      canBreakthrough: thresholdReached && next !== undefined,
      // 后半才是蓄势（§7.3）；挑战进行中按钮要能点（那一次点击 = 手动确认），所以 active 直接放行。
      canChallenge: active || (thresholdReached && next !== undefined && isChargeReady(state.chargeReadyAt, now) && cooldownUntil <= now),
      chargeRemainingMs: chargeRemainingMs(state.chargeReadyAt, now),
      challengeActive: active,
      trialRemainingMs: active ? trialUntil - now : 0,
      cooldownRemainingMs: Math.max(0, cooldownUntil - now),
      demo: demoMode,
      // 试炼这一行的四个数：目标、窗口、此刻窗口内已产出、本境是否已拿到减半。
      // 表里没有目标（末境之后新加的境界行）时给 null，HUD 整行不显示，而不是画一条 0/0 的假进度。
      sprintGoalQi: sprintGoalQi(realmIndex) ?? null,
      sprintProgressQi: sprint.total(),
      sprintWindowMs: SPRINT_WINDOW_MS,
      sprintReached: sprintReachedRealm === realmIndex,
      dao,
      lingGen: lingGenName,
      pillCooldownMs: Math.max(0, pillReadyAt - now),
      // 试炼效率（批次 6）：同窗口内用了多少步、每步换多少灵力。
      // steps 为 0 时效率给 0，HUD 那边用「有没有程序在跑」来决定显不显示，不在这里造 NaN。
      sprintSteps: sprintStepSum,
      sprintPerQi: sprintStepSum > 0 ? sprint.total() / sprintStepSum : 0,
      noiseTicks,
      backlashTicks,
    };
  };

  // 唯一的 sink 出口：衰减（§2.2）与 modifiers（§4）都从 bookSettleDeps 成对进出，
  // 卸下或固化时传 null 就得到完全中性的 1 / []，不可能只剩一半。
  // 玉简（§2.4）挤在同一个 sink 里：命中折扣与命中步数都来自 currentJadeCache，null = 两样都不生效。
  const resetSink = (): void => {
    const bookDeps = bookSettleDeps(currentBook, state.realm);
    sink = makeActionSink({
      content,
      realmIndex,
      jadeCache: currentJadeCache,
      // 道途（批次 7）：邪修的代价只加在「心魔基础增速」上，所以走 demonBase，
      // 不走 demonMult —— demonMult 会把调息的减量一起放大，等于惩罚变奖励。
      demonBase: demonBaseOf(dao),
      ...bookDeps,
      // 道具的通用修正（批次 10：灵珠 +10% 产出、玉净瓶 -10% 心魔增速）与书自带的修正合并。
      // 书与道具是两套内容表，谁也不能覆盖谁。
      modifiers: [...(bookDeps.modifiers ?? []), ...artifactModifiers],
    });
    state.bookId = currentBook?.id ?? null;
    state.bookDecay = sink.mults.bookDecay;
    state.rateMult = sink.mults.rateMult;
    state.demonMult = sink.mults.demonMult;
  };
  resetSink();

  const vm = new Vm({
    content,
    sink: {
      // 离线快进期间走 demonlessSink（心魔不涨），在线期间走原 sink
      execute: (request: ActionRequest) => (offlineQuiet ? offlineWrapper.execute(request) : sink.execute(request)),
    },
    // VM 每 tick 开头读一次快照：宿主的 qi / demon 在这里进 LOAD，分支判断用的就是本 tick 起点的最新值。
    vars: (): VmSnapshot => ({ qi: state.qi, rate: state.rate, demon: state.demon, realm: state.realm, budget: state.budgetPool }),
    onEvent: (event) => {
      // 离线快进一帧吐 3.6 万条事件，红字与 console 都会被刷爆
      if (offlineQuiet) return;
      if (event.t === 'stall') state.stall = event;
      console.warn('[event]', event);
    },
  });
  const scheduler = new Scheduler({
    vm,
    // 原来那句「转离线结算」是假日志：没有任何人调 settleOffline，玩家看到它以为空窗有兜底，其实时间已经抹掉了。
    // 契约 §1 R3 之后，超过一帧预算的 dt 在 run() 开头就被 resumeAway 接走，所以这条只剩防呆作用。
    onOverflowToOffline: (pendingMs) =>
      console.warn(`[补帧丢弃] 丢弃 ${Math.round(pendingMs)} ms（超过单帧补帧上限 ${MAX_CATCHUP_TICKS} tick）`),
  });
  let lastGood: Program | null = null;

  // 没开始就没结算：数字沿用当前值、境界名是当前境，HUD 只把 errors 打进红字。
  const idleResult = (mode: ChallengeMode, attempt: number, rate: number, roll: number, errors: readonly string[]): ChallengeResult => ({
    errors, phase: 'idle', ok: false, mode, attempt, rate, roll, forced: false, qi: state.qi, realmName: currentRealm().name.zh, fromRealmName: currentRealm().name.zh,
  });

  // 结算 = 契约 §7.1 的全部后果。成功复用 breakthrough 规则（境界 +1、qi=0、demon=0）并换 sink；
  // 失败是 qi ×0.85、心魔归 0、悟道 +1、境界不动。报错路径（阈值没到 / 末境 / 坏下标）一个数字都不动，
  // 也不记冷却、不吃掉第 N 次：渡劫压根没开始。
  const settle = (mode: ChallengeMode): ChallengeResult => {
    const attempt = state.attempt;
    // 结算前的境界名：成功路径下面 realmIndex 要 +1，副标「旧 → 新」的旧那一头只能在这里取。
    const fromRealmName = currentRealm().name.zh;
    const outcome = resolveChallenge({
      realms: content.realms,
      realmIndex,
      state: { qi: state.qi, demon: state.demon, realm: state.realm },
      seed: state.seed,
      attempt,
      mode,
    });
    trialUntil = 0;
    if (outcome.errors.length > 0) {
      // 结算口径的拒绝（10 秒里存量掉回阈值下）：数字一个都不动，但这一发确实开始了，得让宿主把原因说出来。
      state.lastChallenge = { ...idleResult(mode, attempt, outcome.rate, outcome.roll, outcome.errors), phase: 'refused' };
      return state.lastChallenge;
    }
    cooldownUntil = clock.now() + CHALLENGE_COOLDOWN_MS;
    // N 是「本境界内第几次」：换成攻下一境的那一境要重新从 1 数，失败留在同境界则继续 +1。
    state.attempt = outcome.ok ? 1 : attempt + 1;
    state.insight += outcome.insight;
    state.qi = outcome.state.qi;
    state.demon = outcome.state.demon;
    state.realm = outcome.state.realm;
    if (outcome.ok) {
      realmIndex = outcome.realmIndex;
      // 新境界的蓄势从「本境界从未达标」重新起算（§7.3），不带着上一境的完成时刻；
      // 失败则原样保留 —— §7.3「同一境界内重复挑战不重置蓄势」。
      state.chargeReadyAt = 0;
      // 试炼窗口跟着境界走：上一境那 60 秒的产出与新境的目标毫无关系，
      // 不清空会让刚破境的玩家立刻「达成」下一境的试炼（契约 §7.1.1 是每境界各自一条）。
      sprint.reset();
  resetSprintSteps();
      state.breakthroughs += 1;
      resetSink();
    }
    scheduler.reset();
    markDirty();
    state.lastChallenge = { errors: [], phase: 'settled', ok: outcome.ok, mode, attempt, rate: outcome.rate, roll: outcome.roll, forced: outcome.forced, qi: state.qi, realmName: currentRealm().name.zh, fromRealmName };
    return state.lastChallenge;
  };

  // 任务 7B：离线结算（契约 §7.2）。快进指定时长的 tick，按 0.6 折算入账。
  // 期间心魔不涨（demonlessSink）、杂念不砍（noiseGainMult 恒 1，因为 demon 不动）、走火不罚（宿主不调 applyBacklash）。
  // 结算后更新 state（qi / realm / attempt / chargeReadyAt），并标脏让宿主落盘。
  const settleOfflineMethod = (input: { readonly lastSeenAt: number; readonly allowBreakthrough: boolean }): OfflineResult | null => {
    const now = clock.now();
    const world = {
      qi: state.qi,
      demon: state.demon,
      realmIndex,
      chargeReadyAt: state.chargeReadyAt,
      attempt: state.attempt,
      seed: state.seed,
    };
    // 离线快进期间静音事件（36 000 条 stall 会刷爆控制台）
    offlineQuiet = true;
    try {
      const result = settleOfflineIfAway({
        vm,
        realms: content.realms,
        world,
        now,
        lastSeenAt: input.lastSeenAt,
        allowBreakthrough: input.allowBreakthrough,
        chargeWindowMs: (realmIdx) => chargeWindowFor(realmIdx),
        onBreakthrough: (newRealmIndex) => {
          // 境界已换成 newRealmIndex，宿主重建 sink（产出乘数链跟着境界走）
          realmIndex = newRealmIndex;
          // 离线渡劫也换境界：窗口属于「刚才那一境」，不留给下一境白拿减半（离线产出本就不计窗口）。
          sprint.reset();
  resetSprintSteps();
          resetSink();
        },
      });
      // 契约 §7.2「下限 60 秒」：没到一分钟连快进都没跑过，也就没有报告可出。
      if (result === null) return null;
      // 结算成功：把 world 的终态写回 state
      state.qi = result.finalQi;
      state.demon = world.demon;  // 离线不涨心魔，但渡劫成功会涤清
      realmIndex = world.realmIndex;
      state.realm = content.realms[realmIndex]?.id ?? 0;
      state.chargeReadyAt = world.chargeReadyAt;
      state.attempt = world.attempt;
      // 离线期间的产出计入 totalQi（credited 口径，与在线一致）
      state.totalQi += result.creditedGained;
      // 离线期间的 tick 数计入 ticks（与在线一致）
      state.ticks += result.ran;
      // 离线期间的 playMs 不计（契约 §5.1：playMs 只算在线操作时长）
      // 境界变了要重建 sink（onBreakthrough 已经做了），但 chargeReadyAt 也变了，要标脏
      if (result.breakthroughs.length > 0 || result.ran > 0) {
        markDirty();
      }
      return result;
    } finally {
      offlineQuiet = false;
    }
  };

  // 一帧的真实推进。scaledMs 是喂给 Scheduler 的模拟时间（已含倍速），realMs 是对应的真实墙钟
  // —— playMs 只认后者（契约 §5.1「在线操作时长」不能被 3× 吹大）。后台空窗由 run() 分流到 resumeAway。
  const step = (scaledMs: number, realMs: number): TickResult[] => {
    const now = clock.now();
    // 挑战的 10 秒是墙钟，和走火惩罚期并行：暂停只冻 tick 产出，不该把渡劫拖长。
    // 放在函数开头，惩罚期那一帧也能按托管结算 —— 玩家「放手」的语义就是到点必出结果。
    if (trialUntil !== 0 && now >= trialUntil) settle('auto');
    const remaining = pausedUntil - now;
    if (remaining > 0) {
      // 惩罚期：不跑 tick、不计 playMs（D3），accumulator 也清掉。
      // 必须 reset：攒着 dt 的话恢复瞬间 5 秒会排成 50 tick 突发，而这段惩罚本该一分钱不产出。
      // 空窗路径不受影响 —— planAwayResume 先把 pausedUntil 的剩余从 gap 头部扣掉，
      // 所以「走火后立刻切标签页」换不来产出，只会白白让惩罚期走完。
      scheduler.reset();
      state.pauseRemainingMs = remaining;
      return [];
    }
    state.pauseRemainingMs = 0;
    // 倍速已经在 run() 里乘进 scaledMs（任务 9 裁定 3：只改「这一帧真实时间里跑几个 tick」），
    // 超过一帧预算的 dt 也已经在 run() 分流给 resumeAway，所以这里正常不会再撞 Scheduler 的溢出。
    // playMs 在函数末尾加的是 realMs —— 契约 §5.1 的在线操作时长不能被倍速吹大。
    const results = scheduler.advance(scaledMs);
    let processed = 0;
    for (const result of results) {
      processed += 1;
      state.tick = result.tick;
      state.stepsThisTick = result.steps;
      // 杂念只砍程序产出 result.gain（D2）：契约 §2.3 把境界被动列为独立加法项，不参与这一刀。
      const mult = noiseGainMult({ demon: state.demon, seed: state.seed, tick: result.tick });
      if (mult < 1) noteTick(noiseTicks, result.tick);
      const gained = (result.gain * mult + passivePerTick(currentRealm())) * daoRate(dao);
      state.qi += gained;
      state.rate = gained * TICKS_PER_SEC;
      state.ticks += 1;
      if (gained > 0) state.totalQi += gained;
      // 蓄势起算点（§7.3「存量首次达到阈值的那一刻」）：逐 tick 判，armCharge 自己幂等。
      // 走火那一 tick 也记：arm 之后掉回阈值下不清零，重复挑战不重置蓄势。
      const armed = armCharge({ realm: currentRealm(), windowMs: chargeWindowMs(), qi: state.qi, chargeReadyAt: state.chargeReadyAt, now });
      if (armed !== state.chargeReadyAt) {
        state.chargeReadyAt = armed;
        // chargeReadyAt 是 §5.1 的存档字段：不标脏就永远写不进档，刷新后 2 分钟从头再等。
        markDirty();
      }
      // 试炼（§7.1.1）：逐 tick 喂 60 秒窗口，达标那一刻把本境界标记立起来。
      // 顺序要紧 —— 先 armCharge 再判试炼：这一 tick 若同时是「首次达标」，用的是上一 tick 为止的窗口，
      // 下一 tick 才享受减半；反过来会让同一 tick 既 arm 出整窗、又立刻挪半窗，两个口径叠一处说不清。
      sprint.push(gained);
      pushSprintSteps(result.steps);
      const goal = sprintGoalQi(realmIndex);
      if (goal !== undefined && sprintReachedRealm !== realmIndex && sprint.isAtOrAbove(goal)) {
        sprintReachedRealm = realmIndex;
        // 另一种时序（先达标、后试炼）：chargeReadyAt 已按整窗写好且 armCharge 幂等，只能在这里前移半窗。
        const shifted = shiftChargeReadyAt(state.chargeReadyAt, fullChargeWindowMs());
        if (shifted !== state.chargeReadyAt) {
          state.chargeReadyAt = shifted;
          markDirty();
        }
      }
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
    // playMs 只算在线操作时长（契约 §5.1）：R3 的重放算在线（心魔都在照涨），离线那一段则由 settleOffline 明确不计。
    // 惩罚期内的帧在函数开头就 return 了；触发走火的那一帧最多多算一个 rAF（约 16 ms / 5000 ms）。
    state.playMs += Math.max(0, realMs);
    state.pauseRemainingMs = Math.max(0, pausedUntil - clock.now());
    return results.slice(0, processed);
  };

  // 契约 §1「后台恢复（R3）」：<60 秒按「错过的帧」重放，≥60 秒才转离线公式，两种都不许静默丢弃。
  // 重放调的是上面那个 step —— 同一个 VM、同一套逐 tick 记账，所以心魔照涨、杂念照砍、走火照罚：
  // 切标签页相对挂机不占便宜，也就没把 §7.2 的 0.6 折扣变成收益（这正是 R2 被否掉的原因）。
  const resumeAway = (gapMs: number, speed: number): TickResult[] => {
    const plan = planAwayResume({ gapMs, penaltyMs: Math.max(0, pausedUntil - clock.now()), speed });
    if (plan.kind === 'offline') {
      // lastSeenAt 取真实空窗的头部：闭关报告上那「X 分 Y 秒」就是玩家离开的墙钟。
      const result = settleOfflineMethod({
        lastSeenAt: clock.now() - gapMs,
        allowBreakthrough: deps.allowBreakthrough?.() ?? false,
      });
      if (result !== null) deps.onOfflineReport?.(result);
      return [];
    }
    if (plan.penaltyMs > 0) console.info(`[空窗扣除] 走火惩罚期扣 ${Math.round(plan.penaltyMs)} ms（这一段不产出）`);
    const out: TickResult[] = [];
    for (let left = plan.ticks; left > 0; left -= MAX_CATCHUP_TICKS) {
      const chunk = Math.min(left, MAX_CATCHUP_TICKS);
      const simMs = chunk * TICK_MS;
      out.push(...step(simMs, simMs / speed));
      // 重放中途踩出走火：剩下的空窗归惩罚期，明说吃掉多少，而不是让 Scheduler 抹掉 accumulator。
      if (state.pauseRemainingMs > 0 && left > chunk) {
        console.warn(`[补帧中止] 走火惩罚期吃掉剩余 ${Math.round(((left - chunk) * TICK_MS) / speed)} ms（未入账）`);
        break;
      }
    }
    return out;
  };

  return {
    run: (dtMs) => {
      // 双保险：loop 已经夹过帧，但 run 是公开入口（visibilitychange、以后的测试都直接调它），
      // 负数与非有限值在这里归 0，绝不把 RangeError 抛回宿主的 rAF 链。
      const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
      // 分流阈值看模拟时间：倍速下 200ms 的真帧已经是 600ms 模拟，同样超出一帧预算（§1「倍速也受此上限约束」）。
      const speed = demoSpeed(demoMode);
      if (dt * speed >= AWAY_FRAME_BUDGET_MS) return resumeAway(dt, speed);
      return step(dt * speed, dt);
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
      // §5.1 的 budgetPool 照样落盘（schema 兼容），但它只是上一次算出来的面值：
      // 真正的池由 attachArtifacts 按 equippedArtifacts 现算，改档把 200 改成 2000 不会凭空多预算。
      state.budgetPool = BASE_BUDGET;
      state.breakthroughs = saved.stats.breakthroughs;
      state.playMs = saved.stats.playMs;
      // 每个会话的 tick 计数与事件列表从头开始（存档里没有它们），惩罚期也不跨会话带走。
      state.tick = 0;
      noiseTicks.length = 0;
      backlashTicks.length = 0;
      pausedUntil = 0;
      state.pauseRemainingMs = 0;
      // 挑战的墙钟与保底计数不跨会话（§5.1 没有这些字段）：读档后回到「本境界第 1 次、没在挑战、没在冷却」。
      trialUntil = 0;
      cooldownUntil = 0;
      state.attempt = 1;
      state.insight = 0;
      // 试炼与 attempt / insight 同族：只在内存，换档 / 重载一律重新攒 60 秒。
      // 不清 sprintReachedRealm 的话，「上一档在筑基拿到的减半」会跟着新档的筑基境界生效。
      sprint.reset();
  resetSprintSteps();
      sprintReachedRealm = null;
      // 上一份会话的结算结果不带进这一局：否则刚刷新就看见一句陈年的「渡劫失败」。
      state.lastChallenge = null;
      // realms.json 现在有 4 行（炼气/筑基/金丹/元婴，契约 §2.3）：
      // 存档里的境界没有对应产出表时明说，不静默用炼气的乘数算出个偏低速率。
      const index = content.realms.findIndex((realm) => realm.id === saved.realm);
      const fallback = index < 0;
      realmIndex = fallback ? 0 : index;
      state.realm = content.realms[realmIndex]?.id ?? 0;
      // 蓄势时刻优先读档面：任务 5 落的 v1 档没这个字段（undefined），补一次 arm 而不是报错，
      // 否则「刷新继续等剩余窗口」这条验收会读回 NaN 比较（undefined >= number 恒 false → 按钮永远灰）。
      state.chargeReadyAt = Number.isFinite(saved.chargeReadyAt) ? saved.chargeReadyAt : 0;
      // 装备位由宿主在 restore 之后 attachBook / attachArtifacts 回来（runtime 不查目录）：这里先清成中性，
      // 免得上一份会话的书衰减或玉简规格残留在 sink 里。
      currentBook = null;
      currentJadeCache = null;
      vm.setBudget(BASE_BUDGET);
      resetSink();
      // 存量已经达标却还没有蓄势时刻（离线达标、或读的是任务 5 那份没有该字段的档）：从这一帧补起算点。
      // 拿当前时刻而不是达标时刻，是因为契约没存达标时刻；宁可多等，也不给玩家一个假就绪。
      const armed = armCharge({ realm: currentRealm(), windowMs: chargeWindowMs(), qi: state.qi, chargeReadyAt: state.chargeReadyAt, now: clock.now() });
      if (armed !== state.chargeReadyAt) {
        state.chargeReadyAt = armed;
        markDirty();
      }
      if (fallback) {
        errors.push(`存档境界 ${saved.realm} 在 content/realms.json 里还没有产出表（现有 ${content.realms.map((realm) => realm.id).join('/')}），先按境界 ${state.realm} 算`);
      }
      return errors;
    },
    attachBook: (book) => {
      currentBook = book;
      resetSink();
    },
    attachArtifacts: (equipment) => {
      currentJadeCache = equipment.jadeCache;
      artifactModifiers = equipment.modifiers;
      resetSink();
      // 池 = BASE_BUDGET + 道具加成（契约 §2.4「预算 = BASE_BUDGET(200) + 算盘加成」）。
      // 只换池不重建 VM：重建会把 ticksRun 归零，同种子回放就此散架。
      const pool = BASE_BUDGET + equipment.budgetBonus;
      vm.setBudget(pool);
      state.budgetPool = pool;
      // 道具变更会让上一 tick 的 stall 失效：红字描述的是「按旧预算跑出来的执行状态」，
      // 池或命中步价一变，那一 tick 的截断点就不成立了，留着等于告诉玩家一个已经不存在故障。
      // 换程序时同样清（见 load）；stall 只在 stall 事件里写，所以不主动清就会一直挂到下一次真截断。
      state.stall = null;
    },
    pressChallenge: (mode: ChallengeMode = 'manual'): ChallengeResult => {
      const now = clock.now();
      // 挑战中再点一次 = 当场结算：主按钮给 'manual'（85%），「交给天意」给 'auto'（60%）。
      // 已经到期那一帧交给 run() 按托管结算，这里不抢它的口径。
      if (trialUntil !== 0) return trialUntil > now ? settle(mode) : settle('auto');
      if (pausedUntil > now) return idleResult('manual', state.attempt, 0, 0, [`走火入魔还剩 ${Math.ceil((pausedUntil - now) / 1000)} 秒，惩罚期内不能渡劫`]);
      const realm = currentRealm();
      if (!isThresholdReached(state.qi, realm)) {
        return idleResult('manual', state.attempt, 0, 0, [`存量 ${Qi.format(state.qi)} 未达 ${realm.name.zh} 阈值 ${Qi.format(realm.threshold)}，渡劫无从开始`]);
      }
      if (realmIndex + 1 >= content.realms.length) return idleResult('manual', state.attempt, 0, 0, [`已是最高境界（${realm.name.zh}），无可渡之劫`]);
      if (cooldownUntil > now) return idleResult('manual', state.attempt, 0, 0, [`上次渡劫的冷却还没走完，还剩 ${Math.ceil((cooldownUntil - now) / 1000)} 秒`]);
      // 兜底：HUD 已经把按钮置灰，直接调 API（debug 句柄）也要能看见原因，不静默 no-op。
      if (!isChargeReady(state.chargeReadyAt, now)) {
        return idleResult('manual', state.attempt, 0, 0, [chargeRemainingMs(state.chargeReadyAt, now) > 0
          ? `蓄势还需 ${Math.ceil(chargeRemainingMs(state.chargeReadyAt, now) / 1000)} 秒`
          : '本境界存量还没达到过阈值，蓄势尚未开始']);
      }
      // 演示模式：跳过 10 秒倒计时，直接按手动口径结算（评审 1:50 那一步只有几秒画面）。
      if (demoMode) return settle('manual');
      trialUntil = now + CHALLENGE_TRIAL_MS;
      return { errors: [], phase: 'trial', ok: false, mode: null, attempt: state.attempt, rate: 0, roll: 0, forced: false, qi: state.qi, realmName: realm.name.zh, fromRealmName: realm.name.zh };
    },
    jumpToDemoTarget: () => {
      // 两道闸：URL 没开演示就不跳（裁定 2 同源的理由：这是改玩家数字的动作），表里查不到目标境也不跳。
      if (!demoMode) return null;
      const target = demoJumpTarget(content.realms);
      if (target === null) return null;
      realmIndex = target.realmIndex;
      state.realm = currentRealm().id;
      state.qi = target.qi;
      // 后果照搬「渡劫成功刚落到这一境」那一套（§7.1）：心魔涤清、蓄势从头起算、试炼窗口清空，
      // 挑战与冷却清零 —— 留着上一境的 60 秒窗口，玩家一落地就「达成」下一境的试炼。
      state.demon = 0;
      state.chargeReadyAt = 0;
      state.attempt = 1;
      sprint.reset();
  resetSprintSteps();
      trialUntil = 0;
      cooldownUntil = 0;
      resetSink();
      scheduler.reset();
      markDirty();
      return { ...target, threshold: currentRealm().threshold };
    },
    settleOffline: settleOfflineMethod,
    setDao: (path: DaoPath) => {
      if (dao === path) return;
      dao = path;
      // 产出倍率在 run() 里现读，心魔基数在 sink 里固定：两者都要立刻生效，所以重建 sink。
      resetSink();
      markDirty();
    },
    takePill: () => {
      const now = wallClock.now();
      if (state.pauseRemainingMs > 0) return { ok: false, reason: '走火入魔期间无法服丹' };
      if (now < pillReadyAt) return { ok: false, reason: `丹炉还在温养（${((pillReadyAt - now) / 1000).toFixed(1)} 秒）` };
      if (state.demon <= 0.02) return { ok: false, reason: '心魔已经很低了，别浪费' };
      if (state.qi < currentRealm().threshold * 0.02) return { ok: false, reason: '存量太少，服丹会伤根本' };
      state.qi -= state.qi * 0.05;
      state.demon = Math.max(0, state.demon - 0.15);
      pillReadyAt = now + PILL_COOLDOWN_MS;
      markDirty();
      return { ok: true };
    },
    preview: (program) => program === null
      ? null
      : previewCurve({ content, realmIndex, code: program.code, budget: vm.budget }),
    state: () => ({ ...state, ...realmView() }),
  };
}
