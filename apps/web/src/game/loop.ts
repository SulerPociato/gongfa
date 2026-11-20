import { AWAY_FRAME_BUDGET_MS } from '@gongfa/core';
import type { Runtime, RuntimeState } from './runtime';

export interface Loop {
  start(): void;
  stop(): void;
}

// 时钟只负责按 rAF 取真实间隔并交给 runtime.run（契约 §4.5）。
// 数值（qi / demon / rate）由 runtime 持有：一帧补 5 tick 时每个 tick 都会更新，
// 分支判断读到的是当前 tick 的最新值，而不是上一帧的快照。

// 停过一次的现场：rAF 回调拿到的 now 是「帧开始时刻」，而 visibilitychange 里写进 last 的是
// performance.now() 的「回调时刻」—— 同一帧里后者能比前者晚上几毫秒，dt 就成了 -10。
// Scheduler.advance 对此抛 RangeError，异常顺着 run() 冒出帧函数，末尾那句 requestAnimationFrame 就没机会执行，
// rAF 链当场断掉，游戏从那一帧起静止 —— 所以帧值进 runtime 之前先归范围。
// 上界 250ms：比这更长的「单帧」不可能是真的帧距，宁可少算一帧也不能把异常留给宿主。
const FRAME_DT_MAX_MS = 250;

/**
 * 一帧的合法区间 [0, 250]，负数与非有限值当 0。
 * 唯一例外是空窗：≥ 一帧预算（500ms）不叫长帧，原样放行给 run() 按契约 §1 R3 全额记账 ——
 * 窗口最小化、系统休眠这些不触发 visibilitychange 的空档只剩这一条路，夹成 250 就是静默丢弃。
 */
export function clampFrameDt(dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  if (dt >= AWAY_FRAME_BUDGET_MS) return dt;
  return Math.min(dt, FRAME_DT_MAX_MS);
}

export function createLoop(runtime: Runtime, onState: (state: RuntimeState) => void): Loop {
  let handle = 0;
  let last = 0;

  const frame = (now: number): void => {
    const dt = last === 0 ? 0 : clampFrameDt(now - last);
    last = now;
    runtime.run(dt);
    onState(runtime.state());
    handle = requestAnimationFrame(frame);
  };

  // 契约 §1「后台恢复（R3）」的入口。标签页隐藏时 rAF 整个冻住，切回后第一帧的 dt 就是整段空窗；
  // 与其等那一帧（浏览器还可能先塞一次小 dt 把 gap 切碎），不如在 visibilitychange 里当场把 gap 交给 runtime。
  // last 是唯一基准：监听器与 rAF 帧读写同一个值，谁先到谁付钱，另一个算出 gap≈0，同一段时间不会被付两次。
  // 阈值用真实时间的一帧预算：演示倍速下更小的真帧由下一帧的 run() 分流接走，同样不丢。
  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible' || last === 0) return;
    const now = performance.now();
    const gap = now - last;
    if (gap < AWAY_FRAME_BUDGET_MS) return;
    last = now;
    runtime.run(gap);
    onState(runtime.state());
  };

  return {
    start() {
      if (handle !== 0) return;
      last = 0;
      document.addEventListener('visibilitychange', onVisibility);
      handle = requestAnimationFrame(frame);
    },
    stop() {
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(handle);
      handle = 0;
    },
  };
}
