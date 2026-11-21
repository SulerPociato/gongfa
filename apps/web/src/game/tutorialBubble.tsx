import { useEffect, useRef, useState } from 'react';
import { tutorialTarget, type TutorialPlayStep } from './tutorial';
import { isTargetVisible, placeBubble, spotlightRect, type BoxRect, type BubbleSide } from './tutorialPlace';

/**
 * 引导气泡 + 高亮环（需求变更 2026-11-21）：这一步该看的那个元素旁边贴一句话，而不是底部一条文字。
 *
 * 这个文件是引导里唯一碰 document 的地方，两条规矩：
 * ① 元素身份绝不缓存 —— updateToolbox 会把整棵 flyout 换成新 DOM（App.tsx 的 applyToolbox 注释），
 *    Blockly 重渲染同样换节点，所以每次重算都重新 querySelector，高亮 class 也跟着重挂；
 * ② 贴不上就退回底部条 —— 工具箱收起时 .blocklyFlyout 是 display:none，后代矩形全 0，
 *    这时气泡必须消失，不许停在屏幕角落。
 *
 * 分工：React 只管 className（侧向 + 是否显示），坐标写在 style 属性上 ——
 * 400ms 一次的几何重不该走渲染，而这里没有传 style prop，React 不会把这几个属性覆盖掉。
 */

/** 400ms 兜底重算：Blockly 内部改 DOM 不通知任何人，光靠 ResizeObserver 会漏。 */
const POLL_MS = 400;

export interface TutorialBubbleProps {
  /** 只会在还在走的六步里渲染：结束态没有目标，那句「自己试」由底部条完整文案来说。 */
  readonly step: TutorialPlayStep;
  readonly text: string;
  readonly total: number;
  /** 「工具箱重建过了」的计数：换过 DOM 就立刻重挂高亮，不等下一次轮询。 */
  readonly rev: number;
  /** 气泡贴上了没有：true = 底部条降级成「n/6 · 跳过引导」，false = 底部条给完整文案。 */
  readonly onPlaced: (placed: boolean) => void;
}

/** 每次重新查：不缓存元素身份。 */
function findTarget(step: TutorialPlayStep): Element | null {
  const target = tutorialTarget(step);
  if (target === null) return null;
  return target.kind === 'flyout'
    ? document.querySelector(`.blocklyFlyout .blocklyDraggable.${target.type}`)
    : document.querySelector(target.selector);
}

/** flyout 右边界（视口坐标）。flyout 不存在或 display:none 时返回 null。 */
function getFlyoutRight(): number | null {
  const flyout = document.querySelector('.blocklyFlyout');
  if (flyout === null) return null;
  const r = flyout.getBoundingClientRect();
  if (r.width === 0) return null;
  return r.x + r.width;
}

export function TutorialBubble({ step, text, total, rev, onPlaced }: TutorialBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const [side, setSide] = useState<BubbleSide>('right');
  const [placed, setPlaced] = useState(false);

  useEffect(() => {
    const bubble = bubbleRef.current;
    const ring = ringRef.current;
    if (bubble === null || ring === null) return;

    let spot: Element | null = null;
    const setSpot = (next: Element | null): void => {
      if (spot === next) return;
      spot?.classList.remove('tut-spot');
      spot = next;
      next?.classList.add('tut-spot');
    };
    let reported = false;
    const report = (ok: boolean): void => {
      setPlaced(ok);
      if (reported === ok) return;
      reported = ok;
      onPlaced(ok);
    };

    const measure = (): void => {
      const el = findTarget(step);
      if (el === null) {
        setSpot(null);
        report(false);
        return;
      }
      const r = el.getBoundingClientRect();
      const box: BoxRect = { x: r.x, y: r.y, width: r.width, height: r.height };
      const vp: BoxRect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      const flyoutRight = getFlyoutRight();
      const p = isTargetVisible(box, vp)
        ? placeBubble(box, { x: 0, y: 0, width: bubble.offsetWidth, height: bubble.offsetHeight }, vp, flyoutRight)
        : null;
      if (p === null) {
        setSpot(null);
        report(false);
        return;
      }
      const s = spotlightRect(box);
      ring.style.left = `${s.x}px`;
      ring.style.top = `${s.y}px`;
      ring.style.width = `${s.width}px`;
      ring.style.height = `${s.height}px`;
      bubble.style.left = `${p.left}px`;
      bubble.style.top = `${p.top}px`;
      // 箭头锚在目标中心（视口坐标）换算成气泡自身坐标：气泡被视口边界挤开时，箭头仍指着目标。
      const cross = p.side === 'left' || p.side === 'right' ? p.arrowCross - p.top : p.arrowCross - p.left;
      bubble.style.setProperty('--tut-arrow', `${cross.toFixed(1)}px`);
      setSide(p.side);
      setSpot(el);
      report(true);
    };

    measure();
    const timer = window.setInterval(measure, POLL_MS);
    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(document.documentElement);
    observer.observe(bubble);
    window.addEventListener('resize', measure);
    // capture：HUD 那一栏自己滚、画布那一栏自己滚，都不冒泡到 window，只有捕获阶段听得见。
    window.addEventListener('scroll', measure, true);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      setSpot(null);
      report(false);
    };
  }, [step, text, total, rev, onPlaced]);

  const on = placed ? ' is-on' : '';
  return (
    <>
      <div ref={ringRef} className={`tut-ring${on}`} aria-hidden="true" />
      <div ref={bubbleRef} className={`tutorial-bubble side-${side}${on}`} role="status">
        <span className="tutorial-bubble-badge">{`${step}/${total}`}</span>
        <span className="tutorial-bubble-text">{text}</span>
      </div>
    </>
  );
}
