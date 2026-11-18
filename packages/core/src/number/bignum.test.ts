import { describe, expect, it } from 'vitest';
import { MAX_EXACT_QI, Qi } from './bignum';

describe('Qi 四则', () => {
  it('加减乘除', () => {
    expect(Qi.add(10, 5)).toBe(15);
    expect(Qi.sub(10, 5)).toBe(5);
    expect(Qi.mul(10, 5)).toBe(50);
    expect(Qi.div(10, 4)).toBe(2.5);
  });

  it('契约量级 1e15 内整数精确', () => {
    expect(Qi.mul(1e8, 1e7)).toBe(1e15);
    expect(Qi.sub(Qi.add(1e15, 1), 1e15)).toBe(1);
    expect(Qi.cmp(Qi.add(1e15, 1), 1e15)).toBe(1);
    expect(Qi.exceedsExact(1e15)).toBe(false);
    expect(Qi.exceedsExact(MAX_EXACT_QI * 10)).toBe(true);
  });

  it('除 0 与非有限数抛 RangeError', () => {
    expect(() => Qi.div(1, 0)).toThrow(RangeError);
    expect(() => Qi.of(Number.NaN)).toThrow(RangeError);
    expect(() => Qi.add(Number.POSITIVE_INFINITY, 1)).toThrow(RangeError);
  });

  it('比较', () => {
    expect(Qi.cmp(1, 2)).toBe(-1);
    expect(Qi.cmp(2, 2)).toBe(0);
    expect(Qi.cmp(3, 2)).toBe(1);
    expect(Qi.lt(1, 2)).toBe(true);
    expect(Qi.gte(2, 2)).toBe(true);
  });
});

describe('Qi 序列化', () => {
  it('小整数直显，大数走 4 位有效科学计数', () => {
    expect(Qi.format(0)).toBe('0');
    expect(Qi.format(600)).toBe('600');
    expect(Qi.format(999999)).toBe('999999');
    expect(Qi.format(1e6)).toBe('1.000e+6');
    expect(Qi.format(1e15)).toBe('1.000e+15');
  });

  it('parse 接受科学计数与空白', () => {
    expect(Qi.parse('2e4')).toBe(20000);
    expect(Qi.parse(' 1e3 ')).toBe(1000);
  });

  it('format 输出可回环', () => {
    for (const value of [0, 600, 1e6, 1234567, 1e15]) {
      expect(Qi.format(Qi.parse(Qi.format(value)))).toBe(Qi.format(value));
    }
  });

  it('非法字符串抛 RangeError', () => {
    expect(() => Qi.parse('')).toThrow(RangeError);
    expect(() => Qi.parse('   ')).toThrow(RangeError);
    expect(() => Qi.parse('abc')).toThrow(RangeError);
  });
});
