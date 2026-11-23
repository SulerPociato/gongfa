import actionsJson from '../../../../content/actions.json';
import { BLOCK_SPECS, COMPARE_DEFAULT_THRESHOLD, COMPARE_LEFT_LABELS } from '@gongfa/blocks';
import { AUTO_RATE, CHALLENGE_TRIAL_MS, actionMult } from '@gongfa/core';
import type { SaveStorage } from '@gongfa/core';
import { compareParts } from './format';

/**
 * 六步引导的步骤机（任务 8 P0-D）。
 * 这里不许 import React / DOM / Blockly：能纯函数化才说明「走到哪一步」是可由信号推出的事实，
 * 而不是散在组件里的副作用。DOM 侧（高亮 class、updateToolbox、计时器）全部留在 App.tsx。
 */

// 永久关闭的存档位。和 gongfa:settings 同级、不进存档 schema，所以不需要迁移（契约 §5.1 没有它）。
export const TUTORIAL_KEY = 'gongfa:tutorial';
export const TUTORIAL_DONE = 'done';

/**
 * 老玩家保护：操作时长（playMs，契约 §5.1 只算在线，离线不进来）超过它就不再启动引导，
 * 并且当场写 done —— 玩了 15 分钟还没走完引导的人，本来也不会再回头看。
 */
export const TUTORIAL_PLAY_MS_MAX = 15 * 60_000;
/** 裁定 1/2 之间的间隔：吐纳落地后 3 秒放出「调息」「比较」。 */
export const RELEASE_AFTER_DRAG_MS = 5_000;
/**
 * 第 4 步的停留时长。第 3 步（breath ≥ 2）和第 4 步（对比行出现）由同一次拖拽同时满足，
 * 不加停留第 4 步会在下一帧就被跨过 —— 那句「看，10.0 → 18.0」玩家一个字都来不及看完。
 */
export const STEP4_DWELL_MS = 5_000;
/** 结束文案的展示时长，到点收条。 */
export const END_DWELL_MS = 8_000;
/** 第 5 步只在心魔真的在往上走时提示：0 心魔就说「心魔在涨」是假话。 */
export const DEMON_HINT = 0.1;

export const TUTORIAL_TOTAL = 6;

export type TutorialStep = 1 | 2 | 3 | 4 | 5 | 6 | 'done';
/** 推导与状态机的「还在走」那一段：'done' 只由走完或跳过产生，不从现场状态推出来。 */
export type TutorialPlayStep = Exclude<TutorialStep, 'done'>;

export interface TutorialSignals {
  /** 画布上的「吐纳」块数（flyout 里的那份不算） */
  readonly breath: number;
  readonly calm: number;
  readonly qi: number;
  readonly demon: number;
  /** 对比行此刻可见（P0-B 的 lastCompare 非空） */
  readonly hasCompare: boolean;
  /** 本会话点过「可渡劫」：一旦点过就一直算点过 */
  readonly pressedChallenge: boolean;
  /** 玩家在这一步点了「继续」（批次 15：翻页改成由玩家点击驱动） */
  readonly clicked?: boolean;
}

/**
 * 各步最短停留：按**字数**查表，不按"带不带数字"。
 * 中文阅读 5–6 字/秒，加上气泡入场，每步至少留「读完 + 1.5 秒余量」：
 *   步 1（33 字）6.5s｜步 2（21 字）4.5s｜步 3（43 字）8s
 *   步 4（30 字）6.5s｜步 5（53 字）10s｜步 6（33 字）6.5s
 * 原来的统一 3 秒会让第 3/5 步在读到一半时被撤走（实测差 4–6 秒）。
 */
export const MIN_STEP_DWELL_MS = 4_500;

/**
 * 批次 15：翻页改成**玩家点击驱动**。
 * 原来按字数定时翻页，实测问题很直接：读得慢的人还没看完就被撤走，
 * 读得快的人又要干等 —— 同一份停留时间不可能同时满足两种人。
 * 现在气泡右侧有「继续 →」，玩家点一下才走；这里只保留一个防误触下限，
 * 避免一进来手一抖就跳过整段文字。
 */
export const MIN_ADVANCE_MS = 800;

const STEP_DWELL_MS: Readonly<Record<number, number>> = {
  1: 6_500,
  2: 4_500,
  3: 8_000,
  4: 6_500,
  5: 10_000,
  6: 6_500,
};

export function stepDwellMs(step: TutorialPlayStep): number {
  return STEP_DWELL_MS[step] ?? MIN_STEP_DWELL_MS;
}

export function nextTutorialStep(step: TutorialStep, sig: TutorialSignals, stepAgeMs: number): TutorialStep {
  if (step === 'done') return 'done';
  // 点过「可渡劫」是比继续更强的信号：第 5 步直接跳到第 6 步，第 6 步直接收尾。
  if (sig.pressedChallenge) return step === 6 ? 'done' : 6;
  // 批次 15：只有玩家点了「继续」才翻页；没有点击就停在这一步，读多久都行。
  if (sig.clicked !== true || stepAgeMs < MIN_ADVANCE_MS) return step;
  if (step === 6) return 'done';
  // 第 4 步按现场事实分叉：心魔没被压下去就不教调息，直接去渡劫（原裁定保留）。
  if (step === 4) return sig.demon > DEMON_HINT ? 5 : 6;
  return (step + 1) as TutorialStep;
}

/** 第 4 步要复述的数字：与曲线面板同源，字段名刻意和 CurveCompare 对齐。 */
export interface CompareNumbers {
  readonly fromPerSec: number;
  readonly toPerSec: number;
  readonly percent: number;
}

export interface TutorialNumbers {
  /** 模型速率（previewCurve 的 perSec），不是 state.rate */
  readonly perSec: number;
  readonly compare: CompareNumbers | null;
  /** 试炼目标：realms/sprint 表里的数，null = 表没这一行，结束文案就不报目标 */
  readonly goalQi: number | null;
  /** 窗口秒数，从 sprintWindowMs 除出来，不写死 60 */
  readonly windowSec: number;
  /** 实时心魔（0–1）。第 5 步要说「已经 X% 了」，那这个 X 只能是当下这一帧的值。 */
  readonly demon: number;
}

/** 倍率文本：0.80 → 「0.8」。表里的 actionMult 改了，这句话跟着变。 */
function multText(mult: number): string {
  return String(Number(mult.toFixed(2)));
}

/** 引导的每一句都要解释「为什么」，而数字必须来自表和现场状态，不是抄进字符串的字面量。 */
export function tutorialText(step: TutorialStep, n: TutorialNumbers): string {
  switch (step) {
    case 1:
      return '先把「吐纳」拖进「每 tick」下面的凹槽。它每 tick 产一次灵力。';
    // 「+10」是模型速率不是字面量：表改成 baseGain 2 这句话得跟着变，不然引导就在念旧数值。
    // qi 刚过 0 的那一帧曲线还没算出来，宁可不报数字也不报「+0」——那是假话。
    case 2:
      return n.perSec > 0
        ? `每秒 +${Math.round(n.perSec)} 灵力。这个数字就是你的算法效率。`
        : '灵力在涨了。这个数字就是你的算法效率。';
    case 3:
      return `再拖一块试试。同样一 tick 里第二块只值 ${multText(actionMult(2))} 倍 —— 这就是边际递减，但总产出还是涨了。`;
    case 4: {
      const c = n.compare;
      if (c === null) return '看，产出涨了 —— 数字就在曲线面板那一行。';
      const p = compareParts(c.fromPerSec, c.toPerSec, c.percent);
      return `看，${p.from} → ${p.to} 每秒（${p.percent}%）。同样的时间，多算一遍。`;
    }
    // 第 5 步的百分比每帧重算：这句是「心魔现在多少」的读数，不是一个固定台词。
    // 低到不足 DEMON_HINT 时说「已经 X% 了——拖调息压住它」自相矛盾（它本来就压着），改口讲涨法。
    case 5: {
      // 百分比取整到 1%：每 100ms 重算一次小数会让整句每秒被重写 10 次，
      // 玩家看到的是"文字在抖"，不是"心魔在涨"（评审实测）。
      const pct = Math.round(n.demon * 100);
      return n.demon >= DEMON_HINT
        ? `注意心魔：它按「每个动作」涨，你吐纳叠得越多涨得越快。现在它已经 ${pct}% 了 —— 拖一个「调息」进来压住它。`
        : `心魔按「每个动作」涨，吐纳叠得越多涨得越快。现在 ${pct}%，还压得住 —— 拖一个「调息」进来。`;
    }
    // 10 秒 / 60% 都从 realm 表常量取：trialMs 或 AUTO_RATE 一改，这句话不能还在报旧数。
    case 6:
      return `存量满了。点「可渡劫」—— 渡劫有 ${CHALLENGE_TRIAL_MS / 1000} 秒，不操作会按 ${Math.round(AUTO_RATE * 100)}% 自动结算。`;
    case 'done':
      return n.goalQi === null
        ? '从这里开始，自己试。'
        : `从这里开始，自己试。目标：${n.windowSec} 秒产出 ${n.goalQi}`;
  }
}

export interface TutorialBarModel {
  readonly text: string;
  /** null = 结束态：不报「n/6」，也不给跳过按钮（没有可跳的了） */
  readonly step: TutorialPlayStep | null;
  readonly total: number;
}

export function tutorialBar(step: TutorialStep, n: TutorialNumbers): TutorialBarModel {
  return { text: tutorialText(step, n), step: step === 'done' ? null : step, total: TUTORIAL_TOTAL };
}

/**
 * 引导期间从工具箱里临时藏掉的块（裁定 5：只藏 content 那两块，「如果 / 循环」本来就归境界门控管）。
 * 藏块只改 ToolboxJson，不碰画布上已有的积木，境界门控照旧生效。
 */
export function hiddenToolboxTypes(active: boolean, released: boolean): readonly string[] {
  if (!active || released) return [];
  return ['calm', 'gongfa_compare'];
}

/** 当前步该在工具箱里聚焦哪一块（降对比度规则的例外）；null = 不聚焦任何块。 */
export function flyoutFocusType(step: TutorialStep): string | null {
  if (step === 1 || step === 3) return 'breath';
  if (step === 5) return 'calm';
  return null;
}

/**
 * 需求 15：工具箱放出新一批积木的那一刻，每块挂 2 秒「新」角标，气泡改指其中一块。
 * 文案里的数值一个都不许抄：label 来自 BLOCK_SPECS，心魔增减来自 content/actions.json，
 * 比较块的默认阈值与左值来自积木定义（packages/blocks 那份 JSON 是唯一的写处）。
 * 引 @gongfa/blocks 不破「不许 import Blockly」这条：definitions.ts 是一堆纯数据。
 */
export const NEW_BADGE_MS = 2_000;

export interface ReleasedBlock {
  readonly id: string;
  readonly label: string;
  /** BLOCK_SPECS 里的种类；表里没这个 id 记 'unknown'（介绍就不能提它干什么）。 */
  readonly kind: 'entry' | 'action' | 'control' | 'value' | 'unknown';
  /** actions.json 里这一行的 demonDelta；表里没这块就是 null —— 宁可不说，也不编一个数。 */
  readonly demonDelta: number | null;
}

/** 按块 id 现查三份表。传进来的 id 就是工具箱里新增的那几项，不预设一定是调息。 */
export function releasedBlock(id: string): ReleasedBlock {
  const spec = BLOCK_SPECS[id];
  const row = actionsJson.find((action) => action.id === id);
  return {
    id,
    label: spec?.label ?? id,
    kind: spec?.kind ?? 'unknown',
    demonDelta: row === undefined ? null : row.demonDelta,
  };
}

export function releasedBlocks(ids: readonly string[]): readonly ReleasedBlock[] {
  return ids.map(releasedBlock);
}

/** 负数自带「-」，正值补「+」：「每次 0.0005 心魔」听着像在压，那是反话。 */
function signedDelta(d: number): string {
  return d > 0 ? `+${d}` : String(d);
}

/** 表里查不到功能的块只报「新」，不替它编一句介绍。 */
function releasedGeneric(b: ReleasedBlock): string {
  return `「${b.label}」刚放出来，可以拖进画布试试。`;
}

const RELEASED_BADGE: Readonly<Record<string, (b: ReleasedBlock) => string>> = {
  calm: (b) =>
    b.demonDelta === null
      ? releasedGeneric(b)
      : `${b.label}：每次 ${signedDelta(b.demonDelta)} 心魔，代价是占一个动作槽`,
  gongfa_compare: (b) =>
    `${b.label}：把 ${COMPARE_LEFT_LABELS.join(' / ')} 和 ${COMPARE_DEFAULT_THRESHOLD} 比大小，得出真或假。`,
};

export function releasedBadgeText(block: ReleasedBlock): string {
  return (RELEASED_BADGE[block.id] ?? releasedGeneric)(block);
}

/** 这 2 秒气泡指谁：优先动作块 —— 「占一个动作槽」这个代价只有它有资格说。不写死调息。 */
export function releasedFocus(blocks: readonly ReleasedBlock[]): ReleasedBlock | null {
  if (blocks.length === 0) return null;
  return blocks.find((b) => b.kind === 'action') ?? blocks[0] ?? null;
}

/** 释放窗口内的覆盖目标；窗口外传 null，气泡回到这一步自己的靶子。 */
export function releasedTarget(block: ReleasedBlock | null): TutorialTarget | null {
  return block === null ? null : { kind: 'flyout', type: block.id };
}

/**
 * 气泡要贴的目标（需求变更 2026-11-21）：只说「找什么」，不说「找到了谁」。
 * 'flyout' = 工具箱里某一类块；'dom' = 一个稳定选择器。
 * DOM 侧每次重算都要重新 querySelector：updateToolbox 会把整棵 flyout 换成新 DOM，
 * 缓存元素身份等于把高亮挂在已废弃的节点上。
 */
export type TutorialTarget =
  | { readonly kind: 'flyout'; readonly type: string }
  | { readonly kind: 'dom'; readonly selector: string };

/**
 * 第 4 步是 .curve-compare（曲线面板里「产出 X → Y / 秒」那一行），不是 .compare：
 * 仓库里没有 .compare 这个类。它是条件渲染的（没有可比基线时整行不存在），所以这一步经常合理地退回底部条。
 */
export function tutorialTarget(step: TutorialStep): TutorialTarget | null {
  switch (step) {
    case 1:
    case 3:
      return { kind: 'flyout', type: 'breath' };
    case 2:
      return { kind: 'dom', selector: '.hud .qi' };
    case 4:
      return { kind: 'dom', selector: '.hud .curve-compare' };
    case 5:
      return { kind: 'flyout', type: 'calm' };
    case 6:
      return { kind: 'dom', selector: '.hud .challenge-button' };
    case 'done':
      return null;
  }
}

/** 目标的稳定字符串键：FLIP 用它判「换靶子了没有」，日志与依赖数组也都用它，不用对象身份。 */
export function tutorialTargetKeyOf(target: TutorialTarget | null): string {
  if (target === null) return 'none';
  return target.kind === 'flyout' ? `flyout:${target.type}` : target.selector;
}

/** 当前步在指谁（字符串键）。 */
export function tutorialTargetKey(step: TutorialStep): string {
  return tutorialTargetKeyOf(tutorialTarget(step));
}

/**
 * 启动判据只有两条：没永久关闭过、不在演示模式（裁定 5：评审第一眼要看全量积木）。
 * 以前还要求「无存档 + 开局 5 秒内 + 画布没动作块」，结果就是真机 BUG：只要落过一次盘，
 * 刷新就永远不再启动，六步引导直接消失 —— 而进度本来就不落盘，能接着走才是对的语义。
 * playMs 这一条是反向的闸门：超过 15 分钟的人不再被打断（宿主同时把这个状态写成 done）。
 */
export function tutorialActiveAt(input: {
  readonly done: boolean;
  readonly demo: boolean;
  readonly playMs: number;
}): boolean {
  return !input.done && !input.demo && input.playMs <= TUTORIAL_PLAY_MS_MAX;
}

/**
 * 刷新后「接着走」的第几步：从眼前的画布与存量倒推，取满足条件的最大步骤。
 * 这些条件与 nextTutorialStep 用的是同一批事实，所以推导出来的落点和一路走过来的结果一致。
 * 画布上有「调息」不进步骤：第 5→6 的跨越靠点渡劫按钮，积木数说了不算（裁定里写死的 4 或 5）。
 * canBreakthrough 是 nextTutorialStep 那份信号里没有的输入：内存里的「本会话点过渡劫」跨不过刷新，
 * 但「存量已经满了」是存档里的事实，可以直接把人放到最后一步等着按按钮。
 */
export function resumeTutorialStep(input: {
  readonly breath: number;
  readonly qi: number;
  readonly demon: number;
  readonly canBreakthrough: boolean;
}): TutorialPlayStep {
  let step: TutorialPlayStep = 1;
  if (input.qi > 0) step = 2;
  if (input.breath >= 1 && input.qi > 0) step = 3;
  if (input.breath >= 2) step = 4;
  if (input.demon > DEMON_HINT && step < 5) step = 5;
  if (input.canBreakthrough) step = 6;
  return step;
}

// 只有「永久关闭」这一个状态要落盘：进度本身是内存态（和 attempt / insight 同一类，刷新清零）。
export function readTutorialDone(storage: SaveStorage): boolean {
  return storage.read(TUTORIAL_KEY) === TUTORIAL_DONE;
}

export function writeTutorialDone(storage: SaveStorage): void {
  storage.write(TUTORIAL_KEY, TUTORIAL_DONE);
}
