import { describe, expect, it } from 'vitest';
import {
  BUBBLE_GAP_PX,
  LEFT_COLUMN_THRESHOLD,
  VIEWPORT_MARGIN_PX,
  isTargetVisible,
  placeBubble,
  spotlightRect,
} from './tutorialPlace';

const VP = { width: 1440, height: 900 };
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe('isTargetVisible（不可见判据：宽高 > 0 且与视口相交）', () => {
  it('display:none 的矩形全 0：工具箱收起时 flyout 里的块就是这个样子', () => {
    expect(isTargetVisible(rect(16, 8, 0, 0), VP)).toBe(false);
  });

  it('尺寸为负或非有限值也算不可见', () => {
    expect(isTargetVisible(rect(16, 8, -1, 35), VP)).toBe(false);
    expect(isTargetVisible(rect(Number.NaN, 8, 50, 35), VP)).toBe(false);
  });

  it('整块移出视口不可见，压到边上仍算可见', () => {
    expect(isTargetVisible(rect(2000, 8, 50, 35), VP)).toBe(false);
    expect(isTargetVisible(rect(-60, 8, 50, 35), VP)).toBe(false);
    expect(isTargetVisible(rect(1439, 8, 50, 35), VP)).toBe(true);
  });
});

describe('placeBubble（左栏强制右侧，其余右→下→上→左，不与目标相交）', () => {
  it('左栏目标（x < 220）+ flyoutRight：强制右侧，气泡 left = flyoutRight + gap', () => {
    const flyoutRight = 200;
    const p = placeBubble(rect(30, 100, 60, 40), rect(0, 0, 240, 60), VP, flyoutRight);
    expect(p?.side).toBe('right');
    expect(p?.left).toBe(flyoutRight + BUBBLE_GAP_PX);
    expect(LEFT_COLUMN_THRESHOLD).toBe(220);
  });

  it('左栏目标无 flyoutRight：走普通优先级（右→下→上→左）', () => {
    const p = placeBubble(rect(30, 100, 60, 40), rect(0, 0, 240, 60), VP, null);
    expect(p?.side).toBe('right');
    expect(p?.left).toBe(30 + 60 + BUBBLE_GAP_PX);
  });

  it('非左栏目标：优先右侧', () => {
    const p = placeBubble(rect(400, 300, 50, 35), rect(0, 0, 240, 60), VP, null);
    expect(p?.side).toBe('right');
    expect(p?.left).toBe(400 + 50 + BUBBLE_GAP_PX);
  });

  it('右侧放不下 → 下方', () => {
    const p = placeBubble(rect(1400, 300, 30, 35), rect(0, 0, 240, 60), VP, null);
    expect(p?.side).toBe('below');
  });

  it('右侧和下方都放不下 → 上方', () => {
    const p = placeBubble(rect(1400, 850, 30, 35), rect(0, 0, 240, 60), VP, null);
    expect(p?.side).toBe('above');
  });

  it('右、下、上都放不下 → 左侧（用大气泡迫使上下都不够）', () => {
    // 气泡高 800，目标在中间：上方 top = 450-12-800 < 0，下方 bottom = 450+35+12+800 > 900
    const p = placeBubble(rect(1400, 450, 30, 35), rect(0, 0, 240, 800), VP, null);
    expect(p?.side).toBe('left');
  });

  it('气泡与目标不允许相交', () => {
    // 目标很大，右侧放不下且会相交 → 走下方
    const p = placeBubble(rect(100, 100, 1000, 600), rect(0, 0, 240, 60), VP, null);
    if (p !== null) {
      const bubbleRect = rect(p.left, p.top, 240, 60);
      const targetRect = rect(100, 100, 1000, 600);
      const intersects =
        bubbleRect.x < targetRect.x + targetRect.width &&
        bubbleRect.x + bubbleRect.width > targetRect.x &&
        bubbleRect.y < targetRect.y + targetRect.height &&
        bubbleRect.y + bubbleRect.height > targetRect.y;
      expect(intersects).toBe(false);
    }
  });

  it('左栏目标强制右侧时也不与目标相交', () => {
    const flyoutRight = 200;
    const p = placeBubble(rect(30, 100, 60, 40), rect(0, 0, 240, 60), VP, flyoutRight);
    if (p !== null) {
      const bubbleRect = rect(p.left, p.top, 240, 60);
      const targetRect = rect(30, 100, 60, 40);
      const intersects =
        bubbleRect.x < targetRect.x + targetRect.width &&
        bubbleRect.x + bubbleRect.width > targetRect.x &&
        bubbleRect.y < targetRect.y + targetRect.height &&
        bubbleRect.y + bubbleRect.height > targetRect.y;
      expect(intersects).toBe(false);
    }
  });

  it('气泡自己比视口还大 → null（四个方向都不够）', () => {
    expect(placeBubble(rect(10, 10, 50, 50), rect(0, 0, 1500, 60), VP)).toBeNull();
    expect(placeBubble(rect(10, 10, 50, 50), rect(0, 0, 0, 0), VP)).toBeNull();
  });

  it('1280×720 与 1440×900：右栏按钮（第 6 步）气泡都不出屏', () => {
    for (const vp of [{ width: 1280, height: 720 }, VP]) {
      const button = rect(vp.width - 260 + 18, 300, 224, 34);
      const p = placeBubble(button, rect(0, 0, 240, 60), vp, null);
      expect(p).not.toBeNull();
      expect(p!.left + 240).toBeLessThanOrEqual(vp.width - VIEWPORT_MARGIN_PX);
      expect(p!.top + 60).toBeLessThanOrEqual(vp.height - VIEWPORT_MARGIN_PX);
      expect(p!.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
    }
  });

  it('左栏目标在 1280×720：气泡完整可见', () => {
    const vp = { width: 1280, height: 720 };
    const flyoutRight = 200;
    const p = placeBubble(rect(30, 100, 60, 40), rect(0, 0, 280, 80), vp, flyoutRight);
    expect(p).not.toBeNull();
    expect(p!.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
    expect(p!.left + 280).toBeLessThanOrEqual(vp.width - VIEWPORT_MARGIN_PX);
    expect(p!.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
    expect(p!.top + 80).toBeLessThanOrEqual(vp.height - VIEWPORT_MARGIN_PX);
  });
});

describe('spotlightRect（环 = 目标外扩 2px，与原生 outline 同位）', () => {
  it('四边各外扩 2px，尺寸 +4', () => {
    expect(spotlightRect(rect(16, 8, 50, 35))).toEqual({ x: 14, y: 6, width: 54, height: 39 });
  });
});
