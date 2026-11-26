import { describe, expect, it } from 'vitest';
import { palettePlacement } from './palette';

// 批次 19 补：移动端「点加」的三条落位规则。
// 真机 bug：第 1 块接进 BODY 之后，第 2、3 块走 moveBy 浮空（workspace 里没有 inputs/next，DOM 重叠），
// 玩家点「吐纳」速率仍是 10.0/s —— 看起来像按钮坏了。
describe('palettePlacement', () => {
  it('值积木（比较 / 阵图）永远浮空，不往语句链里塞', () => {
    expect(palettePlacement({ statement: false, bodyConnected: false, tailHasNext: false })).toBe('float');
    expect(palettePlacement({ statement: false, bodyConnected: true, tailHasNext: true })).toBe('float');
  });

  it('BODY 空着：语句块接进 BODY（第 1 块的主路径）', () => {
    expect(palettePlacement({ statement: true, bodyConnected: false, tailHasNext: false })).toBe('body');
  });

  it('BODY 已占、链尾还有 next：接链尾（第 2 块起的主路径）', () => {
    expect(palettePlacement({ statement: true, bodyConnected: true, tailHasNext: true })).toBe('chain');
  });

  it('BODY 已占、链尾没有 next（例如链尾是值积木/被占满）：只能浮空', () => {
    expect(palettePlacement({ statement: true, bodyConnected: true, tailHasNext: false })).toBe('float');
  });
});
