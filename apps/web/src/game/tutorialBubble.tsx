import { useEffect, useRef, useState } from 'react';
import {
  releasedBadgeText,
  releasedFocus,
  releasedTarget,
  tutorialTarget,
  tutorialTargetKeyOf,
  type ReleasedBlock,
  type TutorialPlayStep,
  type TutorialTarget,
} from './tutorial';
import {
  flipInvert,
  isTargetVisible,
  placeBubble,
  spotlightRect,
  type BoxRect,
  type BubblePosition,
  type BubbleSide,
} from './tutorialPlace';

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

/** CSS 里那段过渡是 200ms（.is-flip），这里给一点余量当作「还在飞」的判定窗口。 */
const FLIP_GUARD_MS = 320;

/**
 * 「这一句已经上屏」的回调兜底。双 rAF 是最接近绘制完成的信号，但 headless 与后台标签会把
 * rAF 压到几乎不回调（本仓库验收时实测 rAF 采样只拿到 1 帧），所以再挂一条定时器：
 * 两条路径只许生效一条，且都不早于绘制 —— 宁可晚报几毫秒，也不能早报，否则停留计时又比眼睛短。
 */
const PAINT_FALLBACK_MS = 100;

function afterPaint(done: () => void): void {
  let fired = false;
  const hit = (): void => {
    if (fired) return;
    fired = true;
    done();
  };
  requestAnimationFrame(() => requestAnimationFrame(hit));
  window.setTimeout(hit, PAINT_FALLBACK_MS);
}

interface FlipState {
  /** 上一次贴在哪儿：下一次 FLIP 的基线。 */
  readonly pos: BubblePosition | null;
  /** 这一时刻之前仍算飞行中，期间不接受任何坐标改写。 */
  readonly flyingUntil: number;
}

export interface TutorialBubbleProps {
  /** 只会在还在走的六步里渲染：结束态没有目标，那句「自己试」由底部条完整文案来说。 */
  readonly step: TutorialPlayStep;
  readonly text: string;
  readonly total: number;
  /** 「工具箱重建过了」的计数：换过 DOM 就立刻重挂高亮，不等下一次轮询。 */
  readonly rev: number;
  /**
   * 需求 15：工具箱刚放出来的那几块（空数组 = 不在这 2 秒里）。
   * 窗口内气泡改指其中一块、文案换成那块的介绍，出窗口自动回到这一步原本的靶子。
   */
  readonly release: readonly ReleasedBlock[];
  /** 气泡贴上了没有：true = 底部条降级成「n/6 · 跳过引导」，false = 底部条给完整文案。 */
  readonly onPlaced: (placed: boolean) => void;
  /**
   * 需求 13 的起表口：这一步的「n/6」真的画到屏上了，宿主才准开始算这 3 秒。
   * 停在 boot 里起表等于状态机自己数自己的时间，玩家看到的会比数到的短几十毫秒。
   */
  readonly onStepPainted: (step: TutorialPlayStep) => void;
  /** 批次 15：玩家点「继续」才翻页 —— 阅读节奏交回玩家手里。 */
  readonly onAdvance: () => void;
}

/** 每次重新查：不缓存元素身份。 */
function findTarget(target: TutorialTarget | null): Element | null {
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

export function TutorialBubble({ step, text, total, rev, release, onPlaced, onStepPainted, onAdvance }: TutorialBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const badgesRef = useRef<HTMLDivElement | null>(null);
  // FLIP 的基线跨步骤存活：effect 每换一步就重建，位置记忆不能跟着清空，否则第 2→3 步还是瞬移。
  const bubbleFlip = useRef<FlipState>({ pos: null, flyingUntil: 0 });
  const ringFlip = useRef<FlipState>({ pos: null, flyingUntil: 0 });
  /** 上一次贴的是哪个目标（tutorialTargetKey）。只有它变了才飞，同目标内位置变化一律即时。 */
  const spotKey = useRef<string | null>(null);
  const [side, setSide] = useState<BubbleSide>('right');
  const [placed, setPlaced] = useState(false);

  // 需求 15 的覆盖：释放窗口内指新块，否则指这一步自己的目标。文案跟着靶子走。
  const focus = releasedFocus(release);
  const target = focus === null ? tutorialTarget(step) : releasedTarget(focus);
  const shown = focus === null ? text : releasedBadgeText(focus);

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

    // FLIP 用「强制一次布局」提交起始值，然后在同一任务里写终点 —— 不排 rAF：
    // headless 里 rAF 会被压到几乎不回调，把归零交给帧回调等于在验收环境下永远瞬移。
    const moveTo = (
      el: HTMLElement,
      state: { current: FlipState },
      next: BubblePosition,
      fly: boolean,
    ): void => {
      const now = performance.now();
      if (state.current.flyingUntil > now) {
        // 正在飞：这一帧绝不擦 transform、也不改 left/top —— 换步时文字一起变长，ResizeObserver
        // 会在过渡刚开始就再测一次；那时把坐标写死，等于把这一段 200ms 拦腰砍断，看着仍是瞬移。
        state.current = { pos: next, flyingUntil: now };
        return;
      }
      const invert = fly ? flipInvert(state.current.pos, next) : null;
      el.style.left = `${next.left}px`;
      el.style.top = `${next.top}px`;
      if (invert === null) {
        // 不飞就把上一次的残留擦掉：留着 translate，下一次写入会和这一段过渡混在一起。
        el.style.transform = '';
        state.current = { pos: next, flyingUntil: 0 };
        return;
      }
      el.style.transition = 'none';
      el.style.transform = invert;
      // 强制一次布局：不逼浏览器把「反向位移」单独结算一次，两次 write 会被合并成一次跳位，FLIP 退化成瞬移。
      void el.offsetWidth;
      // 过渡写在 CSS 的基类上（transform 200ms），这里只把「反向那一下」豁免。
      // 不用 class 开关：React 每次重渲染都会按 prop 重写 className，中途抹掉 is-flip 就把过渡一起掐了。
      el.style.transition = '';
      el.style.transform = 'translate(0px, 0px)';
      state.current = { pos: next, flyingUntil: now + FLIP_GUARD_MS };
    };

    /**
     * 需求 15 的「新」角标：HTML 覆盖层贴在每块新积木的右上角。
     * 不画进 SVG —— SVG 元素没有 ::after，Blockly 的 <g> 上挂不了文字；
     * 也不缓存节点：工具箱一重建就换 DOM，和气泡同一套规矩。
     */
    const placeBadges = (): void => {
      const host = badgesRef.current;
      if (host === null) return;
      for (const el of Array.from(host.querySelectorAll<HTMLElement>('.toolbox-new-badge'))) {
        const block = document.querySelector(`.blocklyFlyout .blocklyDraggable.${el.dataset.block ?? ''}`);
        const r = block?.getBoundingClientRect();
        // flyout 收起来时后代矩形全 0：角标必须跟着消失，不许贴在左上角。
        const on = r !== undefined && r.width > 0 && r.height > 0;
        el.classList.toggle('is-on', on);
        if (!on || r === undefined) continue;
        el.style.left = `${Math.round(r.right)}px`;
        el.style.top = `${Math.round(r.top)}px`;
      }
    };

    const measure = (): void => {
      placeBadges();
      // 拖拽期间不重排：玩家正在拖积木，气泡跟着 400ms 轮询一格一格跳，比"换步时移过去"更像卡顿。
      // 松手后由 Blockly 的 change 事件触发一次重新测量（App 侧 bump rev），位置自然补上。
      if (document.querySelector('.blocklyDragging') !== null) return;
      const el = findTarget(target);
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
      // 只有「这一步在指谁」变了才飞。滚动与窗口变化必须零延迟跟随：给它们加 200ms 过渡，
      // 气泡就会拖在目标后面，那是跟手故障，不是动效。
      const key = tutorialTargetKeyOf(target);
      const fly = spotKey.current !== null && spotKey.current !== key;
      spotKey.current = key;
      const s = spotlightRect(box);
      ring.style.width = `${s.width}px`;
      ring.style.height = `${s.height}px`;
      moveTo(ring, ringFlip, { left: s.x, top: s.y }, fly);
      moveTo(bubble, bubbleFlip, { left: p.left, top: p.top }, fly);
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
    // 裁定 4：依赖里没有 text —— 文案随心魔每帧变，气泡却不该跟着挪。
    // 文字变长变高由 ResizeObserver(bubble) 触发重算，尺寸与位置仍同步。
    // target / shown 都由 step 与 release 推出来，所以依赖里是这两者而不是 target 对象本身
    // （它每次渲染都是新的，写进依赖等于每帧重建 effect）。
  }, [step, total, rev, release, onPlaced]);

  // 需求 13：起表等这一步的文字真上过屏。贴不上时底部条会说同一句话，所以两种状态都算「玩家看得见」。
  useEffect(() => {
    afterPaint(() => {
      onStepPainted(step);
    });
  }, [step, onStepPainted]);

  const on = placed ? ' is-on' : '';
  return (
    <>
      <div ref={ringRef} className={`tut-ring${on}`} aria-hidden="true" />
      {release.length > 0 && (
        <div ref={badgesRef} className="toolbox-new-badges" aria-hidden="true">
          {release.map((block) => (
            <span key={block.id} className="toolbox-new-badge" data-block={block.id}>
              新
            </span>
          ))}
        </div>
      )}
      <div ref={bubbleRef} className={`tutorial-bubble side-${side}${on}`} role="status">
        <span className="tutorial-bubble-badge">{`${step}/${total}`}</span>
        <span className="tutorial-bubble-text">{shown}</span>
        {/* 翻页按钮：只在「这一步自己的文案」时出现；放新块那 2 秒里不抢焦点。 */}
        {focus === null && (
          <button className="tutorial-bubble-next" type="button" onClick={onAdvance}>
            继续 →
          </button>
        )}
      </div>
    </>
  );
}
