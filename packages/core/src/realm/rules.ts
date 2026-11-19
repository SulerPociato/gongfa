import { Qi } from '../number/bignum';
import type { RealmDef } from '../content/schema';
import { TICKS_PER_SEC } from '../types';

// 境界推进的规则（契约 §2.3 被动 + §7.1 成功后果）。本轮只有「存量 ≥ 阈值 → 直接进阶」，
// 渡劫挑战、蓄势、失败代价都在任务 6.5，所以这里不出现概率与冷却。

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
