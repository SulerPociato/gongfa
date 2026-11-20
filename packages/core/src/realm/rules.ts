import { Qi } from '../number/bignum';
import type { RealmDef } from '../content/schema';
import { drawAt } from '../rng/mulberry32';
import { TICKS_PER_SEC } from '../types';

// 境界推进的规则（契约 §2.3 被动 + §7.1 渡劫后果 + §7.3 蓄势）。
// §7.1 的挑战口径（85%/60%、索引段、失败代价）和 §7.3 的窗口算术都归本文件；
// 「要跑多久」「什么时候算 now」由宿主决定，本文件只收常量与毫秒数值。

// 本 tick 的境界被动产出。Qi.div 而不是 /10：passivePerSec 与 TICKS_PER_SEC 的口径要过 §2.3 那条等式。
export function passivePerTick(realm: RealmDef): Qi {
  return Qi.div(realm.passivePerSec, TICKS_PER_SEC);
}

export function isThresholdReached(qi: Qi, realm: RealmDef): boolean {
  return Qi.gte(qi, realm.threshold);
}

export interface RealmNumbers {
  readonly qi: Qi;
  readonly demon: number;
  readonly realm: number;
}

export interface BreakthroughInput {
  readonly realms: readonly RealmDef[];
  readonly realmIndex: number;
  readonly state: RealmNumbers;
}

export interface BreakthroughOutcome {
  readonly ok: boolean;
  readonly realmIndex: number;
  readonly state: RealmNumbers;
  readonly errors: readonly string[];
}

// 失败一律「原样退回 + 一句原因」，不抛异常也不改数字：坏下标来自改过的存档，红字比栈更有用。
// 成功只动 qi / demon / realm 三个数（§7.1「境界 +1、qi = 0、demon = 0」），程序与画布一概不碰。
export function breakthrough(input: BreakthroughInput): BreakthroughOutcome {
  const current = input.realms[input.realmIndex];
  if (current === undefined) {
    return refused(input, [`境界下标 ${input.realmIndex} 不在 realms.json 中（现有 ${input.realms.map((realm) => realm.id).join('/')}）`]);
  }
  const next = input.realms[input.realmIndex + 1];
  if (next === undefined) {
    return refused(input, [`已是最高境界（${current.name.zh}），无可渡之劫`]);
  }
  if (!isThresholdReached(input.state.qi, current)) {
    return refused(input, [`存量 ${Qi.format(input.state.qi)} 未达 ${current.name.zh} 阈值 ${Qi.format(current.threshold)}，还不能突破`]);
  }
  return { ok: true, realmIndex: input.realmIndex + 1, state: { qi: 0, demon: 0, realm: next.id }, errors: [] };
}

function refused(input: BreakthroughInput, errors: readonly string[]): BreakthroughOutcome {
  return { ok: false, realmIndex: input.realmIndex, state: input.state, errors };
}

// ——————————————————————————————————————————————————————————————
// 任务 6.5：蓄势（§7.3）
// ——————————————————————————————————————————————————————————————

// 下标 = 目标境界（要冲进的那一境），值 = 从「存量首次达标」到「可冲关」要等的真实毫秒（§7.3 表）。
// 下标 0 那条从未被读：没有哪次渡劫会冲进炼气，填 0 只为了让数组和 realms.json 一一对齐。
export const CHARGE_WINDOW_MS: readonly number[] = [0, 0, 2 * 60_000, 5 * 60_000];

export interface ArmChargeInput {
  readonly realm: RealmDef;
  readonly windowMs: number;
  readonly qi: Qi;
  readonly chargeReadyAt: number;
  readonly now: number;
}

// 每个 tick 都会调，所以必须幂等：chargeReadyAt 只在本境界第一次写入时算出来，之后原样返回。
// 掉回阈值下也不清 0 —— §7.3「同一境界内重复挑战不重置蓄势」，存量波动同样不算重新开始。
// 窗口为 0 时返回 now 而不是 0：0 专留给「本境界从未达标」，两者在 HUD 上是两句话。
export function armCharge(input: ArmChargeInput): number {
  if (input.chargeReadyAt !== 0) return input.chargeReadyAt;
  if (!isThresholdReached(input.qi, input.realm)) return 0;
  return input.now + input.windowMs;
}

// 等号算就绪：到点那一刻就能冲关，HUD 的 `MM:SS` 归零时按钮必须已经能点。
export function isChargeReady(chargeReadyAt: number, now: number): boolean {
  return chargeReadyAt !== 0 && now >= chargeReadyAt;
}

// 剩余毫秒：未 arm 是 0（HUD 此时说「先攒存量」，不是「还剩 0 秒」）；过点也是 0，不返负数。
export function chargeRemainingMs(chargeReadyAt: number, now: number): number {
  if (chargeReadyAt === 0) return 0;
  return Math.max(0, chargeReadyAt - now);
}

// ——————————————————————————————————————————————————————————————
// 任务 6.5：渡劫结算（§7.1 + 01-design §4.4）
// ——————————————————————————————————————————————————————————————

// 挑战与冷却的时长（§7.1「挑战 10 秒无操作 → 自动结算」「每次渡劫后 60 秒内不可再次冲关」）。
export const CHALLENGE_TRIAL_MS = 10_000;
export const CHALLENGE_COOLDOWN_MS = 60_000;

// §7.1：drawAt(seed, 1_000_000 + 本境界内第 N 次挑战)。N 从 1 起、与 tick 无关，
// 所以「什么时候按按钮」改不了结果，Python 也能照这一段复刻。
export const CHALLENGE_INDEX_BASE = 1_000_000;

// §7.1 的三档数字：手动 0.85、托管与离线 0.60、失败存量 ×0.85；同一境界第 3 次必成。
export const MANUAL_RATE = 0.85;
export const AUTO_RATE = 0.6;
export const FAILURE_QI_MULT = 0.85;
export const GUARANTEE_ATTEMPT = 3;

export type ChallengeMode = 'manual' | 'auto';

export interface ChallengeInput {
  readonly realms: readonly RealmDef[];
  readonly realmIndex: number;
  readonly state: RealmNumbers;
  readonly seed: number;
  // 本境界内第 N 次挑战，从 1 起（成功后由宿主清零，失败后 +1 继续）
  readonly attempt: number;
  readonly mode: ChallengeMode;
}

export interface ChallengeOutcome {
  readonly ok: boolean;
  readonly rate: number;
  readonly roll: number;
  // 第 3 次的成功来自保底而不是骰子，UI 与 Python 都要能区分这两条路
  readonly forced: boolean;
  readonly realmIndex: number;
  readonly state: RealmNumbers;
  readonly insight: number;
  readonly errors: readonly string[];
}

function challengeRefused(input: ChallengeInput, rate: number, roll: number, errors: readonly string[]): ChallengeOutcome {
  return { ok: false, rate, roll, forced: false, realmIndex: input.realmIndex, state: input.state, insight: 0, errors };
}

// 掷骰与门槛检查同一步：结算时存量若已掉到阈值下（10 秒里走了火），这里报错、一个数字都不动，
// 也不发悟道 —— 挑战压根没发生，不是「挑战失败」。
// 成功复用 breakthrough 的后果口径（§7.1 境界 +1、qi = 0、demon = 0）；失败只加两件事：
// 存量 ×0.85 与悟道 +1，境界与程序都不动。
export function resolveChallenge(input: ChallengeInput): ChallengeOutcome {
  const rate = input.mode === 'manual' ? MANUAL_RATE : AUTO_RATE;
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    return challengeRefused(input, rate, 0, [`挑战次数 ${input.attempt} 不合法：本境界内第 N 次要从 1 起取整数`]);
  }
  const current = input.realms[input.realmIndex];
  if (current === undefined) {
    return challengeRefused(input, rate, 0, [`境界下标 ${input.realmIndex} 不在 realms.json 中（现有 ${input.realms.map((realm) => realm.id).join('/')}）`]);
  }
  if (input.realms[input.realmIndex + 1] === undefined) {
    return challengeRefused(input, rate, 0, [`已是最高境界（${current.name.zh}），无可渡之劫`]);
  }
  if (!isThresholdReached(input.state.qi, current)) {
    return challengeRefused(input, rate, 0, [`存量 ${Qi.format(input.state.qi)} 未达 ${current.name.zh} 阈值 ${Qi.format(current.threshold)}，渡劫无从开始`]);
  }
  const roll = drawAt(input.seed, CHALLENGE_INDEX_BASE + input.attempt);
  const forced = input.attempt >= GUARANTEE_ATTEMPT;
  const ok = forced || roll < rate;
  if (ok) {
    const gained = breakthrough({ realms: input.realms, realmIndex: input.realmIndex, state: input.state });
    return { ok: true, rate, roll, forced, realmIndex: gained.realmIndex, state: gained.state, insight: 0, errors: [] };
  }
  return {
    ok: false,
    rate,
    roll,
    forced: false,
    realmIndex: input.realmIndex,
    state: { qi: input.state.qi * FAILURE_QI_MULT, demon: 0, realm: current.id },
    insight: 1,
    errors: [],
  };
}
