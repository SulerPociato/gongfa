/**
 * 本境考校（批次 24）：存量是进度，效率是质量。
 *
 * 玩家问得对：「有目的的优化」不是让你多攒，而是让你在攒的过程中别浪费。
 * 所以考校是**双条件** —— 存量到阈值（本来就要做）+ 效率到本境目标（要多想一步）。
 * 两条都达成时给一个不破坏数值的奖励：渡劫失败不扣存量（「写对了，天不罚你」）。
 *
 * 效率口径 = HUD 那行「灵力/步」= 本 tick 产出 ÷ 本 tick 步数。
 */
export interface ErrandGoal {
  readonly realmIndex: number;
  readonly goal: number;
}

/** 每境一个效率门槛（灵力/步）。刻意留出余量：达标靠「少写废话」，不是靠极限微操。 */
export const ERRAND_GOALS: readonly ErrandGoal[] = [
  { realmIndex: 0, goal: 0.5 },
  { realmIndex: 1, goal: 0.8 },
  { realmIndex: 2, goal: 1.2 },
  { realmIndex: 3, goal: 2.0 },
  { realmIndex: 4, goal: 3.0 },
  { realmIndex: 5, goal: 4.5 },
  { realmIndex: 6, goal: 6.5 },
  { realmIndex: 7, goal: 9.0 },
  { realmIndex: 8, goal: 13.0 },
];

export interface ErrandState {
  readonly goal: number | null;
  /** 效率是否达标（步数为 0 时不算达标，避免空画布白拿）。 */
  readonly met: boolean;
  /** 达标时渡劫失败不扣存量。 */
  readonly mercy: boolean;
}

export function errandOf(realmIndex: number, perQi: number): ErrandState {
  const row = ERRAND_GOALS.find((item) => item.realmIndex === realmIndex);
  if (row === undefined) return { goal: null, met: false, mercy: false };
  const met = Number.isFinite(perQi) && perQi > 0 && perQi >= row.goal;
  return { goal: row.goal, met, mercy: met };
}
