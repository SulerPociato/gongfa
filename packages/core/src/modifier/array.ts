/**
 * 阵图（批次 26）：阵眼收益递减的「索引」模型。
 *
 * 映射：阵眼数 = 索引大小，引灵 = 查询。
 * - 索引越大，单次查询越快（增益递增），但每次执行要多走 k 步；
 * - 第 k 个阵眼只值 0.15 / (1 + 0.3×(k-1))，所以「每步效率」随 k 递减。
 *
 * 这条递减是关键：没有它，最优解永远是「阵眼拉满或清零」，玩家没有可微调的空间。
 */
export const ARRAY_MAX_RUNES = 4;
const RUNE_STEP_COST = 1;
const RUNE_BONUS = 0.15;
const RUNE_DECAY = 0.3;

export function arrayRuneValue(rune: number): number {
  if (!Number.isFinite(rune) || rune < 1) return 0;
  return RUNE_BONUS / (1 + RUNE_DECAY * (rune - 1));
}

/** 阵眼总增益（1 = 无阵法）。k 夹在 0..4。 */
export function arrayBonus(runes: number): number {
  if (!Number.isFinite(runes)) return 1;
  const k = Math.max(0, Math.min(ARRAY_MAX_RUNES, Math.round(runes)));
  let bonus = 1;
  for (let i = 1; i <= k; i += 1) bonus += arrayRuneValue(i);
  return bonus;
}

/** 这次引灵的总步耗：基础 1 步 + 每个阵眼 1 步。 */
export function arrayStepCost(runes: number): number {
  if (!Number.isFinite(runes)) return 1;
  const k = Math.max(0, Math.min(ARRAY_MAX_RUNES, Math.round(runes)));
  return 1 + k * RUNE_STEP_COST;
}
