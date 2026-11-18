import type { Runtime, RuntimeState } from './runtime';

export interface Loop {
  start(): void;
  stop(): void;
}

// 时钟只负责按 rAF 取真实间隔并交给 runtime.run（契约 §4.5）。
// 数值（qi / demon / rate）由 runtime 持有：一帧补 5 tick 时每个 tick 都会更新，
// 分支判断读到的是当前 tick 的最新值，而不是上一帧的快照。
export function createLoop(runtime: Runtime, onState: (state: RuntimeState) => void): Loop {
  let handle = 0;
  let last = 0;

  const frame = (now: number): void => {
    const dt = last === 0 ? 0 : now - last;
    last = now;
    runtime.run(dt);
    onState(runtime.state());
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
