import { TICKS_PER_SEC } from '../types';
import type { Qi } from '../number/bignum';
import { drawAt } from '../rng/mulberry32';

// 01-design §4.4 的心魔规则表，只这三条由本模块负责：>0.7 杂念、=1.0 走火入魔。
// 增长公式在 modifier/settle.ts（§2.2.1），0.5 那条「调息线」是玩家策略而非引擎规则，不在这里。
export const NOISE_LINE = 0.7;
export const NOISE_CHANCE = 0.2;
export const NOISE_GAIN_MULT = 0.5;
export const NOISE_ROLL_PERIOD = TICKS_PER_SEC;
export const BACKLASH_LINE = 1;
export const BACKLASH_QI_MULT = 0.7;
export const BACKLASH_PAUSE_MS = 5000;

// 「每秒 20% 概率」落在每 10 tick 的那一次 roll 上，命中的是这一 tick 的产出（不是每 tick 自己造一个概率）。
// demon 取本 tick 起点的值：VM 也是每 tick 开头读一次快照（vm/interpreter.ts），两边口径一致。
// 返回的是乘数，砍谁由调用方决定——契约 §2.3 把境界被动定义为独立加法项，所以被动不吃这一刀。
export function noiseGainMult(input: { readonly demon: number; readonly seed: number; readonly tick: number }): number {
  if (input.demon <= NOISE_LINE) return 1;
  if (input.tick % NOISE_ROLL_PERIOD !== 0) return 1;
  return drawAt(input.seed, input.tick) < NOISE_CHANCE ? NOISE_GAIN_MULT : 1;
}

// 判据用「夹紧之前」的和：宿主要把 demon 夹到 0..1（契约 §1），夹完再看就分不清「正好 1.0」和「被封顶」。
// 另一半是 d >= 1.0 的兜底：?demon=1 或改档让心魔停在 1.0 上时，下一 tick 立刻走火，不等「越过」。
// 触发后心魔归 0，所以正常玩法不会连续走火；调息把和拉回 1.0 以下则不触发。
export function reachesBacklash(demonBefore: number, demonDelta: number): boolean {
  return demonBefore >= BACKLASH_LINE || demonBefore + demonDelta >= BACKLASH_LINE;
}

// 走火入魔的第一条代价：存量 ×0.7。心魔归 0 与停 5 秒由宿主落（那是状态与时间，不是公式）。
export function applyBacklash(qi: Qi): Qi {
  return qi * BACKLASH_QI_MULT;
}
