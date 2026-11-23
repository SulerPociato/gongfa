import { describe, expect, it } from 'vitest';
import { DEMON_FALL_LINE, DEMON_FALL_MS, DEMON_FALL_RELEASE, demonFallStep } from './runtime';

// 批次 16：守正者长期放纵心魔 → 被拖入魔道（自选之外的第二个入口）。
describe('入魔道：心魔长期高位触发', () => {
  it('守正 + 心魔 80% 以上，累计到 30 秒才堕落', () => {
    let high = 0;
    let fell = false;
    const ticks = DEMON_FALL_MS / 100;
    for (let i = 1; i <= ticks; i += 1) {
      const step = demonFallStep('orthodox', DEMON_FALL_LINE, high, 100);
      high = step.highMs;
      if (step.fall) {
        fell = true;
        expect(i).toBe(ticks);
      }
    }
    expect(fell).toBe(true);
  });

  it('心魔掉回 60% 以下会清零，不会「攒够总时长」', () => {
    let high = 0;
    for (let i = 0; i < 200; i += 1) high = demonFallStep('orthodox', 0.85, high, 100).highMs;
    expect(high).toBeGreaterThan(0);
    expect(demonFallStep('orthodox', DEMON_FALL_RELEASE - 0.01, high, 100)).toEqual({ highMs: 0, fall: false });
  });

  it('已经入魔的不再重复触发；没选道途也不会被触发', () => {
    expect(demonFallStep('heretic', 1, 10_000, 100)).toEqual({ highMs: 0, fall: false });
    expect(demonFallStep(null, 1, 10_000, 100)).toEqual({ highMs: 0, fall: false });
  });
});
