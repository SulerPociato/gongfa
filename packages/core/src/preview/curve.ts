import type { Content, RealmDef } from '../content/schema';
import { BACKLASH_LINE, reachesBacklash } from '../demon/rules';
import { actionMult, demonGrowth } from '../modifier/settle';
import { Qi } from '../number/bignum';
import { passivePerTick } from '../realm/rules';
import { BASE_BUDGET, DEMON_BASE_PER_ACTION, TICKS_PER_SEC } from '../types';
import type { Op } from '../vm/program';
import { tickProfile } from '../vm/profile';

// 任务 8 P0-B：曲线预览（01-design §11.4、架构 §曲线预览「简化模型跑 600 tick，不启动 VM」）。
// 存在的理由是修「一直在等」：搭完积木要能立刻看见「这么改值多少」，而不是等 100 秒验证猜想。
// 批次 2（2026-11-22）把心魔请了回来：裁定是「预览要能回答『拖调息压不压得住』」，
// 只画灵力一条线的话，玩家把程序越叠越猛却看不见代价，引导第 5 步就只能靠嘴说。
// 仍然不建模：杂念（随机）、走火之后的账、玉简命中、法宝与功法书的心魔倍率 —— 免责句照写，面板不许含糊。

/** 预览窗口：60 秒（架构写死的 600 tick）。 */
export const PREVIEW_SECONDS = 60;
export const PREVIEW_TICKS = PREVIEW_SECONDS * TICKS_PER_SEC;
/** 每秒一个点：60 点画得出折线，又不至于让 SVG 里有 600 个顶点。 */
export const PREVIEW_POINTS = PREVIEW_SECONDS;

export interface Linearized {
  /** 依执行序的动作 id；每 tick 第 N 次动作的 k 就是下标 + 1（VM 的 actionSeq 同口径）。 */
  readonly kinds: readonly string[];
  /** 与 kinds 同下标的循环层数（顶层 0）：心魔增长 (1 + 0.5 × 层数) 读的就是这一列。 */
  readonly depths: readonly number[];
  /** 走过的指令步数（含算术与控制流，与 VM 的 steps 同口径）。 */
  readonly steps: number;
  /** 被指令预算截断：程序还有得跑，这一 tick 跑不完。 */
  readonly truncated: boolean;
}

export interface CurveInput {
  readonly content: Content;
  readonly realmIndex: number;
  /** 单个程序的 IR（P0 只有一个「每 tick」入口，契约 §4.4）。 */
  readonly code: readonly Op[];
  /** 每 tick 指令预算：装备算盘会抬高它，宿主把 VM 的真池传进来。 */
  readonly budget?: number | undefined;
  /** 心魔基线：与 SettleDeps.demonBase 同一个注入点（任务 10 跑 0.00004 / 0.00005 两档时两边要一起换）。 */
  readonly demonBase?: number | undefined;
}

export interface CurvePreview {
  /** 60 个点：第 k 个是「从零攒到第 k 秒末」的累计产出，逐 tick 相加得到，不是速率乘秒数。 */
  readonly points: readonly Qi[];
  readonly perTick: Qi;
  readonly perSec: Qi;
  /** 当前境界阈值：画那条水平参考线用。 */
  readonly threshold: Qi;
  readonly realmIndex: number;
  /** 从零攒到阈值的预计秒数；产出为 0 时是 null（不是 Infinity，UI 画不出）。 */
  readonly etaSec: number | null;
  /** 60 秒窗口内够不够到阈值：决定参考线落在图内还是图外，面板据此说「超出本图」。 */
  readonly reachesInWindow: boolean;
  readonly steps: number;
  readonly truncated: boolean;
  /**
   * 心魔累计，与 points 同一套「下标 = 第几秒末」的横轴。走火那一秒也占一格（值就是 BACKLASH_LINE），
   * 所以撞线时它比 points 短一截：灵力线照画满 60 秒，心魔线在撞线处收住（裁定：qi 不折、不补走火之后的账）。
   */
  readonly demonPoints: readonly Qi[];
  /** 窗口内预计撞线的秒数（向上取整，与 etaSec 同一口径）；不撞 = null。 */
  readonly backlashAtSec: number | null;
}

/**
 * 静态线性化：把 IR 压成「一 tick 内依次执行哪些动作」，不建栈、不启动 VM。
 * 展开口径（循环字面次数、`JMP_IF_FALSE` 走 else、步数照 VM）住在 vm/profile.ts 的 tickProfile 里，
 * 与 VM 每 tick 真实执行序列共用那一份 —— 曲线和 HUD 的「动作 M · 层 K」不许各有算法。
 */
export function linearizeProgram(code: readonly Op[], budget: number = BASE_BUDGET): Linearized {
  const profile = tickProfile([code], budget);
  return { kinds: profile.kinds, depths: profile.depths, steps: profile.steps, truncated: profile.truncated };
}

function realmOf(content: Content, index: number): RealmDef {
  const realm = content.realms[index];
  if (realm === undefined) throw new RangeError(`realmIndex ${index} 不在 realms 表中（现有 ${content.realms.map((row) => row.id).join('/')}）`);
  return realm;
}

/**
 * 每 tick 产出 = Σ baseGain × actionMult(k) × realm.actionMult + 境界被动。
 * 乘序照契约 §2.1 与 settle.makeActionSink（心魔/杂念/玉简三项按 1 略过），所以同一份程序
 * 在无干扰时与真 VM 逐位相同 —— 曲线不是第二套数学，只是省掉了那三项。
 */
function tickGain(kinds: readonly string[], content: Content, realm: RealmDef): Qi {
  const actions = new Map(content.actions.map((action) => [action.id, action]));
  let gain = Qi.zero;
  for (let index = 0; index < kinds.length; index += 1) {
    const def = actions.get(kinds[index] ?? '');
    // 表里没有的 id：verifier 那条红字已经在 HUD 上说过，这里按 0 产出继续画，不能让预览把页面崩掉。
    if (def === undefined) continue;
    gain = Qi.add(gain, def.baseGain * actionMult(index + 1) * realm.actionMult);
  }
  return Qi.add(gain, passivePerTick(realm));
}

/**
 * 每 tick 的心魔增量，逐动作一项一项列出来（不是一条「速率 × 秒」）。
 * 每一项都走 makeActionSink 用的同两个函数（demonGrowth 与表里的 demonDelta，契约 §2.2.1），
 * 差别只在这里不乘 mods.demonMult —— 裁定 1：法宝与功法书的倍率不进预览，面板的免责句要写明白。
 * 顺序也照 §2.1 的「先加后乘」原样保留负项：调息压下去的是「表值 + 增长项」这个整体。
 */
function tickDemon(kinds: readonly string[], depths: readonly number[], content: Content, demonBase: number): readonly Qi[] {
  const actions = new Map(content.actions.map((action) => [action.id, action]));
  const deltas: Qi[] = [];
  for (let index = 0; index < kinds.length; index += 1) {
    const def = actions.get(kinds[index] ?? '');
    // 与 tickGain 同一支：表里没有的 id 记 0，让 verifier 的红字去管，预览不崩页面。
    deltas.push(def === undefined ? Qi.zero : def.demonDelta + demonGrowth(demonBase, def.kind, depths[index] ?? 0));
  }
  return deltas;
}

export function previewCurve(input: CurveInput): CurvePreview {
  const budget = input.budget ?? BASE_BUDGET;
  const demonBase = input.demonBase ?? DEMON_BASE_PER_ACTION;
  const realm = realmOf(input.content, input.realmIndex);
  const linear = linearizeProgram(input.code, budget);
  const perTick = tickGain(linear.kinds, input.content, realm);
  const perTickDemon = tickDemon(linear.kinds, linear.depths, input.content, demonBase);

  // 逐 tick 累加、每 10 tick 记一个点：与在线记账同一条加法顺序。
  // 展开只做一次（上面的 linear）：预览窗口内一 tick 的执行序列是定值，逐 tick 重展是白干。
  const points: Qi[] = [];
  let accumulated = Qi.zero;
  for (let tick = 1; tick <= PREVIEW_TICKS; tick += 1) {
    accumulated = Qi.add(accumulated, perTick);
    if (tick % TICKS_PER_SEC === 0) points.push(accumulated);
  }

  const perTickDemonSum = perTickDemon.reduce((total, delta) => Qi.add(total, delta), Qi.zero);
  const demonPoints: Qi[] = [];
  let demon = Qi.zero;
  let backlashAtSec: number | null = null;
  for (let tick = 1; tick <= PREVIEW_TICKS && backlashAtSec === null; tick += 1) {
    // 判据与宿主同一条 reachesBacklash（runtime.ts 的心魔夹紧那段），不自创阈值。
    if (reachesBacklash(demon, perTickDemonSum)) {
      backlashAtSec = Math.ceil(tick / TICKS_PER_SEC);
      demonPoints.push(BACKLASH_LINE);
      break;
    }
    // 夹 0..1 照宿主那一头：上限走火线（判据已在上面看过）、下限让调息能把账压回 0。
    demon = Math.min(BACKLASH_LINE, Math.max(0, Qi.add(demon, perTickDemonSum)));
    if (tick % TICKS_PER_SEC === 0) demonPoints.push(demon);
  }

  // 预计秒数是解析值：阈值 ÷ 每秒产出，向上取整（0.4 秒的零头也算一秒，玩家按秒等）。
  const perSec = perTick * TICKS_PER_SEC;
  return {
    points,
    perTick,
    perSec,
    threshold: realm.threshold,
    realmIndex: input.realmIndex,
    etaSec: perSec > 0 ? Math.ceil(realm.threshold / perSec) : null,
    reachesInWindow: perSec > 0 && realm.threshold / perSec <= PREVIEW_SECONDS,
    steps: linear.steps,
    truncated: linear.truncated,
    demonPoints,
    backlashAtSec,
  };
}
