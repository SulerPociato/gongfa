import { TICKS_PER_SEC } from '@gongfa/core';
import type { Runtime } from './runtime';

export interface LoopState {
  readonly qi: number;
  readonly ratePerSec: number;
  readonly ticks: number;
}

export interface Loop {
  start(): void;
  stop(): void;
}

// 宿主的时钟：rAF 取真实间隔 → Scheduler.advance 按 100ms 定步长补帧（契约 §4.5）。
// 数值口径只有下面两行属于宿主：qi 累加（契约 §5 存量）与 displayRate = perTickGain × tick/秒（契约 §2.2）。
// 境界被动 perTickTotal（§2.3）要等境界推进，任务 6.5 并入，别在这里加乘数。
export function createLoop(runtime: Runtime, onState: (state: LoopState) => void): Loop {
  let handle = 0;
  let last = 0;
  let qi = 0;
  let rate = 0;
  let ticks = 0;

  const frame = (now: number): void => {
    const dt = last === 0 ? 0 : now - last;
    last = now;
    for (const result of runtime.run(dt)) {
      qi += result.gain;
      rate = result.gain * TICKS_PER_SEC;
      ticks += 1;
    }
    onState({ qi, ratePerSec: rate, ticks });
    handle = requestAnimationFrame(frame);
  };

  return {
    start() {
      if (handle !== 0) return;
      last = 0;
      handle = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(handle);
      handle = 0;
    },
  };
}
