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

/** 「首次进游戏」的第三条判据：开局 5 秒内、且画布上没有动作块。 */
export const FIRST_PLAY_MS = 5_000;
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

export function tutorialActiveAt(input: {
  readonly done: boolean;
  readonly fresh: boolean;
  readonly playMs: number;
  readonly demo: boolean;
  readonly actionBlocks: number;
}): boolean {
  return !input.done && input.fresh && input.playMs < FIRST_PLAY_MS && !input.demo && input.actionBlocks === 0;
}

// 只有「永久关闭」这一个状态要落盘：进度本身是内存态（和 attempt / insight 同一类，刷新清零）。
export function readTutorialDone(storage: SaveStorage): boolean {
  return storage.read(TUTORIAL_KEY) === TUTORIAL_DONE;
}

export function writeTutorialDone(storage: SaveStorage): void {
  storage.write(TUTORIAL_KEY, TUTORIAL_DONE);
}
