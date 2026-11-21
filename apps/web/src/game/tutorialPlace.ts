/**
 * 引导气泡的定位数学（需求变更 2026-11-21）。
 * 这里只吃矩形和视口尺寸，不碰 document：Blockly 重渲染、flyout 重建这些脏事全在组件里，
 * 「贴在哪一侧」这件事本身必须是可单测的纯函数。
 */

export interface BoxRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** 气泡边缘到目标边缘的空隙。箭头就活在这 12px 里（长 6px，尖朝目标）。 */
export const BUBBLE_GAP_PX = 12;
/** CSS border 三角的高度，也是气泡与目标之间那段空隙里箭头占掉的长度。 */
export const ARROW_PX = 6;
/** 气泡不许贴到屏幕边上，也不许越出去：留 8px。 */
export const VIEWPORT_MARGIN_PX = 8;
/** 左栏阈值：目标在此左侧视为「工具箱内」，气泡强制放到 flyout 右边界外。 */
export const LEFT_COLUMN_THRESHOLD = 220;

/**
 * 目标算不算「看得见」。display:none 的元素（工具箱收起时的 flyout 就是）矩形宽高都是 0，
 * 所以这里既查尺寸也查与视口是否相交 —— 两条都过才允许把气泡贴上去，否则退回底部条。
 */
export function isTargetVisible(rect: BoxRect, vp: Viewport): boolean {
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
  return rect.x < vp.width && rect.y < vp.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

export type BubbleSide = 'right' | 'left' | 'below' | 'above';

export interface BubblePlacement {
  readonly side: BubbleSide;
  /** 气泡左上角（视口坐标，CSS px）。 */
  readonly left: number;
  readonly top: number;
  /**
   * 箭头尖所在的那条轴（视口坐标）：左右两侧给 arrowCross（纵向），上下两侧给 arrowCross（横向）。
   * 锚在目标中心，不锚在气泡中心 —— 气泡被视口边界挤开时，箭头仍指着目标。
   */
  readonly arrowCross: number;
}

const clamp = (value: number, min: number, max: number): number => (value < min ? min : value > max ? max : value);

/** 两矩形是否相交（含边界接触） */
function rectsIntersect(a: BoxRect, b: BoxRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * 定位规则（2026-11-21 修订）：
 * - 目标在左栏（rect.left < 220）→ 强制右侧，气泡 left = flyoutRight + gap
 * - 其余目标：优先右侧 → 下方 → 上方 → 左侧
 * - 无论哪种，气泡与目标矩形不允许相交
 * - 最终 clamp 到视口内（留 8px 边距）
 *
 * @param flyoutRight flyout 右边界（视口坐标）。左栏目标强制用此值定位；其他目标可传 null。
 */
export function placeBubble(
  target: BoxRect,
  bubble: BoxRect,
  vp: Viewport,
  flyoutRight: number | null = null,
): BubblePlacement | null {
  const w = bubble.width;
  const h = bubble.height;
  if (!(w > 0) || !(h > 0)) return null;
  const limit = VIEWPORT_MARGIN_PX;
  if (w + limit * 2 > vp.width || h + limit * 2 > vp.height) return null;

  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const gap = BUBBLE_GAP_PX;

  // 左栏目标：强制右侧，气泡 left = flyoutRight + gap
  if (target.x < LEFT_COLUMN_THRESHOLD && flyoutRight !== null) {
    const left = flyoutRight + gap;
    const clampedLeft = clamp(left, limit, vp.width - w - limit);
    const top = clamp(cy - h / 2, limit, vp.height - h - limit);
    const bubbleRect: BoxRect = { x: clampedLeft, y: top, width: w, height: h };
    // 不与目标相交
    if (!rectsIntersect(bubbleRect, target)) {
      return {
        side: 'right',
        left: clampedLeft,
        top,
        arrowCross: clamp(cy, top + ARROW_PX + 2, top + h - ARROW_PX - 2),
      };
    }
  }

  // 其余目标：右 → 下 → 上 → 左
  const trySide = (side: BubbleSide): BubblePlacement | null => {
    let left: number;
    let top: number;
    switch (side) {
      case 'right': {
        left = target.x + target.width + gap;
        top = clamp(cy - h / 2, limit, vp.height - h - limit);
        break;
      }
      case 'below': {
        left = clamp(cx - w / 2, limit, vp.width - w - limit);
        top = target.y + target.height + gap;
        break;
      }
      case 'above': {
        left = clamp(cx - w / 2, limit, vp.width - w - limit);
        top = target.y - gap - h;
        break;
      }
      case 'left': {
        left = target.x - gap - w;
        top = clamp(cy - h / 2, limit, vp.height - h - limit);
        break;
      }
    }
    const clampedLeft = clamp(left, limit, vp.width - w - limit);
    const clampedTop = clamp(top, limit, vp.height - h - limit);
    const bubbleRect: BoxRect = { x: clampedLeft, y: clampedTop, width: w, height: h };
    if (rectsIntersect(bubbleRect, target)) return null;
    const arrowCross =
      side === 'right' || side === 'left'
        ? clamp(cy, clampedTop + ARROW_PX + 2, clampedTop + h - ARROW_PX - 2)
        : clamp(cx, clampedLeft + ARROW_PX + 2, clampedLeft + w - ARROW_PX - 2);
    return { side, left: clampedLeft, top: clampedTop, arrowCross };
  };

  for (const side of ['right', 'below', 'above', 'left'] as BubbleSide[]) {
    const p = trySide(side);
    if (p !== null) return p;
  }

  return null;
}

/**
 * 高亮环的矩形：CSS 的 outline 画在 border-box 之外 0..2px，box-shadow 从 border-box 外沿起算。
 * 环用 border 2px 复现 outline 的位置，所以它的 border-box 必须比目标外扩 2px；
 * 于是阴影要写 4px 而不是 6px —— 外沿才是 rect+6，与原生 outline+box-shadow 逐像素一致（实测见
 * .qoder/scratch/probe-spotlight2.mjs：同一 HTML 元素上两种画法 maxΔ=1）。
 */
export function spotlightRect(rect: BoxRect): BoxRect {
  return { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 };
}
