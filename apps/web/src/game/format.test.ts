import { describe, expect, it } from 'vitest';
import { durationText } from './format';

// 闭关报告（契约 §7.2 封顶 60 分钟）：原来直接印「60分0秒」，满一小时要写成「1小时」。
describe('durationText', () => {
  it('不足一小时：X分Y秒（10 分 10 秒的实测报告）', () => {
    expect(durationText(610_000)).toBe('10分10秒');
    expect(durationText(59_000)).toBe('0分59秒');
  });

  it('满 60 分钟：写「1小时」，不写「60分0秒」', () => {
    expect(durationText(60 * 60_000)).toBe('1小时');
    expect(durationText(60 * 60_000 + 15_000)).toBe('1小时15秒');
  });

  it('超过一小时（理论上被 cap 挡住，函数仍不崩）：X小时Y分Z秒', () => {
    expect(durationText(90 * 60_000)).toBe('1小时30分');
    expect(durationText(90 * 60_000 + 5_000)).toBe('1小时30分5秒');
  });

  it('负数与小数：夹到 0、秒向下取整', () => {
    expect(durationText(-5_000)).toBe('0分0秒');
    expect(durationText(9_900)).toBe('0分9秒');
  });
});
