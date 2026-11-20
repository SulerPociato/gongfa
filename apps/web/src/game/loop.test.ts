import { describe, expect, it } from 'vitest';
import { AWAY_FRAME_BUDGET_MS } from '@gongfa/core';
import { clampFrameDt } from './loop';

// 真机停摆的现场：rAF 的 now 是「帧开始时刻」，visibilitychange 写进 last 的是 performance.now()
// 的「回调时刻」，同一帧里能倒挂出 -10ms。红测试的红色证据就是那条 Uncaught RangeError。
describe('clampFrameDt（rAF 帧值归范围）', () => {
  it('负抖动当 0', () => {
    expect(clampFrameDt(-9.999999523162842)).toBe(0);
    expect(clampFrameDt(-1)).toBe(0);
  });

  it('正常帧原样通过', () => {
    expect(clampFrameDt(0)).toBe(0);
    expect(clampFrameDt(16.7)).toBe(16.7);
    expect(clampFrameDt(250)).toBe(250);
  });

  it('超过 250ms 但未成一帧预算的，夹到 250', () => {
    expect(clampFrameDt(251)).toBe(250);
    expect(clampFrameDt(AWAY_FRAME_BUDGET_MS - 1)).toBe(250);
  });

  it('达到一帧预算（500ms）算空窗，原样放行给 §1 R3 记账', () => {
    expect(AWAY_FRAME_BUDGET_MS).toBe(500);
    expect(clampFrameDt(AWAY_FRAME_BUDGET_MS)).toBe(500);
    expect(clampFrameDt(70_000)).toBe(70_000);
    expect(clampFrameDt(20 * 60_000)).toBe(20 * 60_000);
  });

  it('非有限的 dt 当 0，不喂给 Scheduler', () => {
    expect(clampFrameDt(Number.NaN)).toBe(0);
    expect(clampFrameDt(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampFrameDt(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
