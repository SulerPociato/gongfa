import { Qi } from '../number/bignum';
import { TICK_MS } from '../types';

// 试炼（契约 §7.1.1）：把「等蓄势」换成「60 秒内打出目标产出」。
// 达成一次 → 本境界正在等的那个蓄势窗口减半。只算在线逐 tick 产出：
// 离线一次入账三万六千 tick，喂进窗口等于白送减半，所以 settleOffline 不往这里写任何东西。

export const SPRINT_WINDOW_MS = 60_000;
export const SPRINT_WINDOW_TICKS = SPRINT_WINDOW_MS / TICK_MS;

// 下标 = 【当前境界】下标（此刻在哪一境）。与 CHARGE_WINDOW_MS 的【目标境界】下标相反，别写反：
// 在筑基攒够 3 200 减掉的是「筑基 → 金丹」这段等待，窗口按 realmIndex+1 取，目标按 realmIndex 取。
// 2026-11-26 扩到 9 境：化神 2e6 / 炼虚 1.2e7 / 合体 8e7 / 大乘 5e8 / 渡劫 3e9。
export const SPRINT_GOAL_QI: readonly Qi[] = [480, 3_200, 30_000, 157_000, 2_000_000, 12_000_000, 80_000_000, 500_000_000, 3_000_000_000];

// 表里没有的行（末境之后、或 realms.json 加了新境还没配目标）给 undefined = 这一境没有试炼目标，
// 不返回 0：0 会让「窗口和 ≥ 目标」在一帧之内恒真，HUD 立刻显示一条已经达成的假进度。
export function sprintGoalQi(realmIndex: number): Qi | undefined {
  return SPRINT_GOAL_QI[realmIndex];
}

// 逐 tick 写一格、读回最近 N 格的和。窗口用 tick 数而不是墙钟：一格的语义就是「一个 TICK_MS 的产出」，
// 走火停 5 秒时没有 tick 也没有产出，按墙钟滑会把已经掉出窗口的旧产出继续算进来。
export class SprintWindow {
  readonly capacityTicks: number;
  private readonly cells: Qi[];
  private cursor = 0;
  private sum: Qi = Qi.zero;

  constructor(capacityTicks: number = SPRINT_WINDOW_TICKS) {
    this.capacityTicks = capacityTicks;
    this.cells = new Array<Qi>(capacityTicks).fill(Qi.zero);
  }

  // 覆盖前先减掉被挤出去那一格，所以窗口和是 O(1)，每 tick 都调也不重算 600 格。
  push(gained: Qi): void {
    const evicted = this.cells[this.cursor] ?? Qi.zero;
    this.cells[this.cursor] = gained;
    this.sum = Qi.add(Qi.sub(this.sum, evicted), gained);
    this.cursor = (this.cursor + 1) % this.capacityTicks;
  }

  total(): Qi {
    return this.sum;
  }

  isAtOrAbove(goal: Qi): boolean {
    return Qi.gte(this.sum, goal);
  }

  reset(): void {
    this.cells.fill(Qi.zero);
    this.cursor = 0;
    this.sum = Qi.zero;
  }
}

// 达标之前达成试炼：窗口参数减半，armCharge 算出来的就是半窗（base 为 0 时减半仍是 0，
// 炼气、演示模式与 ?charge=0 因此不受影响）。
export function halveChargeWindowMs(baseWindowMs: number, reached: boolean): number {
  return reached ? baseWindowMs / 2 : baseWindowMs;
}

// 达标之后才达成试炼：chargeReadyAt 早就按整窗写死了，armCharge 幂等不会再动它（rules.ts 的幂等约定），
// 所以在这里把完成时刻前移半个窗口 —— 等价于「从 arm 那一刻起只等半窗」，两条时序落在同一个数上。
// 未 arm（0）原样返回：0 专留给「本境界从未达标」，减半由 halveChargeWindowMs 在 arm 时接手。
export function shiftChargeReadyAt(chargeReadyAt: number, baseWindowMs: number): number {
  return chargeReadyAt === 0 ? chargeReadyAt : chargeReadyAt - baseWindowMs / 2;
}
