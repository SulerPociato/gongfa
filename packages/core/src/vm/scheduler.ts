import { TICK_MS } from '../types';
import type { TickResult, Vm } from './interpreter';

// 契约 §4.5 补帧：单帧最多追 5 个 tick，剩余交给离线结算（任务 7）。
export const MAX_CATCHUP_TICKS = 5;

/**
 * 一帧的补帧预算（5 tick = 500ms 模拟时间）。契约 §1「后台恢复（R3）」拿它当分块单位：
 * 空窗不是「一次要补 22 秒」，而是「这 22 秒里错过的每一帧各自补 ≤5 tick」。
 */
export const AWAY_FRAME_BUDGET_MS = MAX_CATCHUP_TICKS * TICK_MS;

export interface SchedulerDeps {
  readonly vm: Vm;
  readonly onTick?: ((result: TickResult) => void) | undefined;
  readonly onOverflowToOffline?: ((pendingMs: number) => void) | undefined;
}

export class Scheduler {
  private readonly vm: Vm;
  private readonly onTick: ((result: TickResult) => void) | undefined;
  private readonly onOverflowToOffline: ((pendingMs: number) => void) | undefined;
  private accumulator = 0;

  constructor(deps: SchedulerDeps) {
    this.vm = deps.vm;
    this.onTick = deps.onTick;
    this.onOverflowToOffline = deps.onOverflowToOffline;
  }

  get pendingMs(): number {
    return this.accumulator;
  }

  advance(dt: number): TickResult[] {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new RangeError(`advance 需要非负有限毫秒数，收到 ${dt}`);
    }
    this.accumulator += dt;

    const ran: TickResult[] = [];
    let executed = 0;
    while (this.accumulator >= TICK_MS && executed < MAX_CATCHUP_TICKS) {
      const result = this.vm.tick();
      ran.push(result);
      this.onTick?.(result);
      this.accumulator -= TICK_MS;
      executed += 1;
    }

    if (executed === MAX_CATCHUP_TICKS && this.accumulator >= TICK_MS) {
      const pendingMs = this.accumulator;
      this.accumulator = 0;
      this.onOverflowToOffline?.(pendingMs);
    }
    return ran;
  }

  reset(): void {
    this.accumulator = 0;
  }
}
