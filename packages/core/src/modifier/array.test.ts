import { describe, expect, it } from 'vitest';
import { ARRAY_MAX_RUNES, arrayBonus, arrayStepCost } from './array';

describe('阵图（阵眼收益递减）', () => {
  it('没有阵眼 = 1 倍、1 步', () => {
    expect(arrayBonus(0)).toBe(1);
    expect(arrayStepCost(0)).toBe(1);
  });

  it('阵眼越多总增益越高，但每步效率越低', () => {
    const values = [1, 2, 3, 4].map((k) => arrayBonus(k));
    expect(values[0]).toBeCloseTo(1.15, 10);
    expect(values[3]!).toBeGreaterThan(values[2]!);
    const efficiency = [1, 2, 3, 4].map((k) => arrayBonus(k) / arrayStepCost(k));
    for (let i = 1; i < efficiency.length; i += 1) {
      expect(efficiency[i]!).toBeLessThan(efficiency[i - 1]!);
    }
  });

  it('越界夹在 0..4，NaN 视作无阵', () => {
    expect(arrayBonus(-3)).toBe(1);
    expect(arrayBonus(99)).toBeCloseTo(arrayBonus(ARRAY_MAX_RUNES), 10);
    expect(arrayBonus(Number.NaN)).toBe(1);
    expect(arrayStepCost(99)).toBe(1 + ARRAY_MAX_RUNES);
  });
});
