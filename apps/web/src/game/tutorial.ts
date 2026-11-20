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
export const RELEASE_AFTER_DRAG_MS = 3_000;
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
}

export function nextTutorialStep(step: TutorialStep, sig: TutorialSignals, stepAgeMs: number): TutorialStep {
  if (step === 'done') return 'done';
  // 裁定 3：第 5 步不设「跳过这步」，直接点渡劫就视为跳到第 6 步；第 6 步等的那一下就是这次点击。
  if (sig.pressedChallenge) return step === 6 ? 'done' : 6;
  switch (step) {
    case 1:
      return sig.breath >= 1 ? 2 : 1;
    case 2:
      return sig.qi > 0 ? 3 : 2;
    case 3:
      return sig.breath >= 2 ? 4 : 3;
    case 4:
      if (!sig.hasCompare || stepAgeMs < STEP4_DWELL_MS) return 4;
      return sig.demon > DEMON_HINT ? 5 : 6;
    case 5:
      return sig.calm >= 1 ? 6 : 5;
    case 6:
      return 6;
  }
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
}

export function tutorialText(step: TutorialStep, n: TutorialNumbers): string {
  switch (step) {
    case 1:
      return '先把「吐纳」拖进「每 tick」下面的凹槽';
    // 「+10」是模型速率不是字面量：表改成 baseGain 2 这句话得跟着变，不然引导就在念旧数值。
    // qi 刚过 0 的那一帧曲线还没算出来，宁可不报数字也不报「+0」——那是假话。
    case 2:
      return n.perSec > 0 ? `每秒 +${Math.round(n.perSec)} 灵力。这就是你的第一条周天` : '灵力在涨了。这就是你的第一条周天';
    case 3:
      return '再拖一块吐纳，看看快多少';
    case 4: {
      const c = n.compare;
      if (c === null) return '看，产出涨了 —— 数字就在曲线面板那一行';
      const p = compareParts(c.fromPerSec, c.toPerSec, c.percent);
      return `看，${p.from} → ${p.to} 每秒（${p.percent}%）。同样的时间，多算一遍`;
    }
    case 5:
      return '心魔在涨。拖一个「调息」能压住它';
    case 6:
      return '存量满了，点「可渡劫」';
    case 'done':
      return n.goalQi === null
        ? '从这里开始，自己试。'
        : `从这里开始，自己试。目标：${n.windowSec} 秒产出 ${n.goalQi}`;
  }
}

export interface TutorialBarModel {
  readonly text: string;
  /** null = 结束态：不报「n/6」，也不给跳过按钮（没有可跳的了） */
  readonly step: number | null;
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
