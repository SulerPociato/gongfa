import { describe, expect, it } from 'vitest';
import { ERRAND_GOALS, errandOf } from './errand';

describe('本境考校（存量 + 效率双条件）', () => {
  it('每境都有门槛，且随境界升高', () => {
    const goals = ERRAND_GOALS.map((row) => row.goal);
    expect(goals.length).toBe(9);
    expect([...goals].sort((a, b) => a - b)).toEqual(goals);
  });

  it('达到门槛才算达标，并给宽恕', () => {
    const low = errandOf(0, 0.4);
    const ok = errandOf(0, 0.5);
    expect(low.met).toBe(false);
    expect(low.mercy).toBe(false);
    expect(ok.met).toBe(true);
    expect(ok.mercy).toBe(true);
  });

  it('空画布（0 步）不算达标，避免白拿', () => {
    expect(errandOf(0, 0).met).toBe(false);
    expect(errandOf(0, Number.NaN).met).toBe(false);
  });

  it('未知境界没有考校', () => {
    expect(errandOf(9, 99)).toEqual({ goal: null, met: false, mercy: false });
  });
});
