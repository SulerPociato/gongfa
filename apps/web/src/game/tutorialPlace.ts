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

export interface BubblePosition {
  readonly left: number;
  readonly top: number;
}

/**
 * 位移小于这个数就当没动（需求 14）。400ms 一次的重算会不断产出 0.01px 级的抖动，
 * 每次都起飞的话气泡会在目标边上一直飘 —— 那是「在动」，不是「移过去」。
 */
export const FLIP_EPSILON_PX = 0.5;

/**
 * FLIP 的 Invert 那一步：新坐标已经写好，这里给出把它推回旧坐标的 transform。
 * null = 不飞（没有基线，或位移在阈值内）。归零交给组件下一帧做，过渡时长在 CSS 里。
 */
export function flipInvert(prev: BubblePosition | null, next: BubblePosition): string | null {
  if (prev === null) return null;
  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  if (Math.abs(dx) < FLIP_EPSILON_PX && Math.abs(dy) < FLIP_EPSILON_PX) return null;
  return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
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
export interface PlaceBounds {
  /** 下方横条的顶边：目标在这里时气泡只能往上，且不得进入横条。 */
  readonly stripTop?: number | undefined;
  /** 右列的左边界：目标在这里时气泡优先落到画布，而不是压在右列卡片上。 */
  readonly rightColumnLeft?: number | undefined;
}

export function placeBubble(
  target: BoxRect,
  bubble: BoxRect,
  vp: Viewport,
  flyoutRight: number | null = null,
  bounds: PlaceBounds = {},
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
        // 右列目标：气泡右边缘必须停在右列左边界之外，否则会压住同列卡片的字。
        if (inRightColumn) {
          left = Math.min(left, columnEdge - gap - w);
        }
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

  // 批次 33：按目标所在区域决定落点，而不是只看"在不在下半屏"。
  //   横条里的目标：只能向上（上方是画布空白），且底边不许进入横条；
  //   右列里的目标：优先向左（左边是画布），放不下再向上。
  const inStrip = bounds.stripTop !== undefined && target.y + target.height > bounds.stripTop;
  // 右列判据用「目标中心在右侧三分之一」而不是只靠 bounds：bounds 是 DOM 现量的，
  // 某些窗口尺寸下 .hud 的 left 会晚一帧才稳定，靠它会漏判（实测 1280×720 第 5 步）。
  const columnEdge = bounds.rightColumnLeft ?? vp.width * 0.62;
  const inRightColumn = cx > columnEdge || (bounds.rightColumnLeft !== undefined && target.x >= bounds.rightColumnLeft);
  const order: BubbleSide[] = inStrip
    ? ['above']
    : inRightColumn
      ? ['left']
      : ['right', 'below', 'above', 'left'];

  // 批次 33：右列与横条各有一条"硬落点"，不走通用试探。
  // 通用顺序在 1280×720 上会把心魔条的气泡放进右列（实测压住 challenge/realm 两张卡），
  // 所以这两类目标直接指定位置，反而稳。
  if (inRightColumn) {
    const left = clamp(columnEdge - gap - w, limit, vp.width - w - limit);
    let top = clamp(cy - h / 2, limit, vp.height - h - limit);
    // 右列卡片可能一直排到横条顶边：气泡还得再往上让，别落进横条。
    if (bounds.stripTop !== undefined) top = Math.min(top, bounds.stripTop - gap - h);
    const rect: BoxRect = { x: left, y: top, width: w, height: h };
    if (!rectsIntersect(rect, target)) {
      return { side: 'left', left, top, arrowCross: clamp(cy, top + ARROW_PX + 2, top + h - ARROW_PX - 2) };
    }
  }
  if (inStrip && bounds.stripTop !== undefined) {
    const top = bounds.stripTop - gap - h;
    const left = clamp(cx - w / 2, limit, vp.width - w - limit);
    if (top >= limit) {
      const rect: BoxRect = { x: left, y: top, width: w, height: h };
      if (!rectsIntersect(rect, target)) {
        return { side: 'above', left, top, arrowCross: clamp(cx, left + ARROW_PX + 2, left + w - ARROW_PX - 2) };
      }
    }
  }

  /** 横条场景：气泡必须整块待在横条上方，否则宁可返回 null 退回引导条。 */
  const clampAboveStrip = (placement: BubblePlacement): BubblePlacement | null => {
    if (!inStrip || bounds.stripTop === undefined) return placement;
    const maxTop = bounds.stripTop - h - gap;
    if (maxTop < limit) return null;
    if (placement.top <= maxTop) return placement;
    return { ...placement, top: maxTop };
  };

  for (const side of order) {
    const p = trySide(side);
    if (p !== null) {
      const clamped = clampAboveStrip(p);
      if (clamped !== null) return clamped;
    }
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
