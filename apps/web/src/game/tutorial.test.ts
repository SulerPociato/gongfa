import { describe, expect, it } from 'vitest';
import type { SaveStorage } from '@gongfa/core';
import { compareParts } from './format';
import {
  DEMON_HINT,
  END_DWELL_MS,
  RELEASE_AFTER_DRAG_MS,
  STEP4_DWELL_MS,
  TUTORIAL_DONE,
  TUTORIAL_KEY,
  TUTORIAL_PLAY_MS_MAX,
  flyoutFocusType,
  hiddenToolboxTypes,
  nextTutorialStep,
  readTutorialDone,
  resumeTutorialStep,
  tutorialActiveAt,
  tutorialBar,
  tutorialText,
  writeTutorialDone,
  type TutorialSignals,
} from './tutorial';

const NO: TutorialSignals = { breath: 0, calm: 0, qi: 0, demon: 0, hasCompare: false, pressedChallenge: false };
const sig = (over: Partial<TutorialSignals>): TutorialSignals => ({ ...NO, ...over });
const NUM = { perSec: 10, compare: null, goalQi: 480, windowSec: 60 };

describe('步骤机：只往前走，条件不满足就停在原地', () => {
  it('第 1 步等第一块吐纳落地', () => {
    expect(nextTutorialStep(1, sig({ qi: 5 }), 9_999)).toBe(1);
    expect(nextTutorialStep(1, sig({ breath: 1 }), 0)).toBe(2);
  });

  it('第 2 步等存量真涨起来（拖完积木到第一个 tick 之间不该就跳过去）', () => {
    expect(nextTutorialStep(2, sig({ breath: 1, qi: 0 }), 9_999)).toBe(2);
    expect(nextTutorialStep(2, sig({ breath: 1, qi: 0.1 }), 0)).toBe(3);
  });

  it('第 3 步等第二块吐纳', () => {
    expect(nextTutorialStep(3, sig({ breath: 1, qi: 50 }), 9_999)).toBe(3);
    expect(nextTutorialStep(3, sig({ breath: 2 }), 0)).toBe(4);
  });

  it('第 4 步要对比行出现且真停留够：同一次拖拽同时满足 3 和 4，不留停留时间这句话会一闪而过', () => {
    expect(nextTutorialStep(4, sig({ breath: 2, hasCompare: true }), STEP4_DWELL_MS - 1)).toBe(4);
    expect(nextTutorialStep(4, sig({ breath: 2, hasCompare: false }), STEP4_DWELL_MS)).toBe(4);
    expect(nextTutorialStep(4, sig({ breath: 2, hasCompare: true }), STEP4_DWELL_MS)).toBe(6);
  });

  it('第 4 步之后：心魔真在涨才提「调息」，否则直接进第 6 步', () => {
    expect(nextTutorialStep(4, sig({ hasCompare: true, demon: 0.1 }), STEP4_DWELL_MS)).toBe(6);
    expect(nextTutorialStep(4, sig({ hasCompare: true, demon: 0.1001 }), STEP4_DWELL_MS)).toBe(5);
  });

  it('第 5 步等调息落地', () => {
    expect(nextTutorialStep(5, sig({ demon: 0.5, calm: 0 }), 9_999)).toBe(5);
    expect(nextTutorialStep(5, sig({ demon: 0.5, calm: 1 }), 0)).toBe(6);
  });

  it('第 6 步等那一下点击，done 之后不再动', () => {
    expect(nextTutorialStep(6, sig({ pressedChallenge: false }), 9_999)).toBe(6);
    expect(nextTutorialStep(6, sig({ pressedChallenge: true }), 0)).toBe('done');
    expect(nextTutorialStep('done', sig({ breath: 9, qi: 1e6, pressedChallenge: true }), 0)).toBe('done');
  });

  it('点过渡劫就当这一套他会了：从第 2 步直落第 6 步，再落结束', () => {
    expect(nextTutorialStep(2, sig({ pressedChallenge: true }), 0)).toBe(6);
    expect(nextTutorialStep(5, sig({ pressedChallenge: true }), 0)).toBe(6);
  });
});

describe('文案：数字全部插值，不许写死', () => {
  it('第 2 步用模型速率', () => {
    expect(tutorialText(2, { ...NUM, perSec: 10 })).toBe('每秒 +10 灵力。这就是你的第一条周天');
    expect(tutorialText(2, { ...NUM, perSec: 24.666_666 }).startsWith('每秒 +25 灵力')).toBe(true);
    expect(tutorialText(2, { ...NUM, perSec: 0 })).toBe('灵力在涨了。这就是你的第一条周天');
  });

  it('第 4 步复述对比行的三个数，不是 10 → 18 / +80% 的常量', () => {
    const compare = { fromPerSec: 61.234, toPerSec: 90.0, percent: 47 };
    const text = tutorialText(4, { ...NUM, compare });
    const p = compareParts(61.234, 90.0, 47);
    expect(text).toBe(`看，${p.from} → ${p.to} 每秒（${p.percent}%）。同样的时间，多算一遍`);
    expect(text).toContain('61.2');
    expect(text).toContain('90.0');
    expect(text).toContain('+47%');
    expect(text).not.toContain('10.0 → 18.0');
    expect(text).not.toContain('80%');
  });

  it('第 4 步在没有对比行时不编数字', () => {
    expect(tutorialText(4, { ...NUM, compare: null })).not.toMatch(/\d+\.\d+ → \d+\.\d+/);
  });

  it('负增长也带符号', () => {
    expect(tutorialText(4, { ...NUM, compare: { fromPerSec: 18, toPerSec: 10, percent: -44 } })).toContain('-44%');
  });

  it('结束文案的目标秒数与产出都来自表', () => {
    expect(tutorialText('done', NUM)).toBe('从这里开始，自己试。目标：60 秒产出 480');
    expect(tutorialText('done', { ...NUM, goalQi: 3200, windowSec: 60 })).toContain('目标：60 秒产出 3200');
    expect(tutorialText('done', { ...NUM, goalQi: null })).toBe('从这里开始，自己试。');
  });

  it('第 1/3/5/6 步是固定话术', () => {
    expect(tutorialText(1, NUM)).toBe('先把「吐纳」拖进「每 tick」下面的凹槽');
    expect(tutorialText(3, NUM)).toBe('再拖一块吐纳，看看快多少');
    expect(tutorialText(5, NUM)).toBe('心魔在涨。拖一个「调息」能压住它');
    expect(tutorialText(6, NUM)).toBe('存量满了，点「可渡劫」');
  });

  it('底部条：中途带步骤号，结束态不带（也没得跳过）', () => {
    expect(tutorialBar(1, NUM)).toEqual({ text: tutorialText(1, NUM), step: 1, total: 6 });
    expect(tutorialBar('done', NUM).step).toBeNull();
  });
});

describe('工具箱临时隐藏与聚焦', () => {
  it('引导中且没放出时藏掉调息与比较；放出或引导没启动就一样不藏', () => {
    expect(hiddenToolboxTypes(true, false)).toEqual(['calm', 'gongfa_compare']);
    expect(hiddenToolboxTypes(true, true)).toEqual([]);
    expect(hiddenToolboxTypes(false, false)).toEqual([]);
  });

  it('聚焦块跟着步骤走：1/3 是吐纳，5 是调息，其余不聚焦', () => {
    expect(flyoutFocusType(1)).toBe('breath');
    expect(flyoutFocusType(3)).toBe('breath');
    expect(flyoutFocusType(5)).toBe('calm');
    expect(flyoutFocusType(2)).toBeNull();
    expect(flyoutFocusType('done')).toBeNull();
  });
});

describe('引导启动判据（刷新后还要接着走）', () => {
  const open = { done: false, demo: false, playMs: 0 };
  it('只认 done 与演示模式：有没有存档、玩到哪一步都不拦', () => {
    expect(tutorialActiveAt(open)).toBe(true);
    expect(tutorialActiveAt({ ...open, playMs: 90_000 })).toBe(true);
    expect(tutorialActiveAt({ ...open, done: true })).toBe(false);
    expect(tutorialActiveAt({ ...open, demo: true })).toBe(false);
  });

  it('老玩家保护：操作时长超过 15 分钟就不再启动（离线不算，§5.1 的 playMs 只记在线）', () => {
    expect(TUTORIAL_PLAY_MS_MAX).toBe(15 * 60_000);
    expect(tutorialActiveAt({ ...open, playMs: TUTORIAL_PLAY_MS_MAX })).toBe(true);
    expect(tutorialActiveAt({ ...open, playMs: TUTORIAL_PLAY_MS_MAX + 1 })).toBe(false);
    expect(tutorialActiveAt({ ...open, playMs: 60 * 60_000 })).toBe(false);
  });

  it('放出与停留的时长是本轮定的那几个数', () => {
    expect(RELEASE_AFTER_DRAG_MS).toBe(3_000);
    expect(STEP4_DWELL_MS).toBe(5_000);
    expect(END_DWELL_MS).toBe(8_000);
  });
});

// 进度不落盘（只有 done 落），所以刷新后要从「眼前画布与存量」倒推该从第几步接着走。
describe('resumeTutorialStep：刷新后按状态续播', () => {
  const empty = { breath: 0, qi: 0, demon: 0, canBreakthrough: false };
  it('空画布、零存量 → 第 1 步', () => {
    expect(resumeTutorialStep(empty)).toBe(1);
  });

  it('有灵力但没积木（产出来自离线或存档带入）→ 第 2 步', () => {
    expect(resumeTutorialStep({ ...empty, qi: 5 })).toBe(2);
    expect(resumeTutorialStep({ ...empty, qi: 0.001 })).toBe(2);
  });

  it('一块吐纳且已经在产出 → 第 3 步', () => {
    expect(resumeTutorialStep({ ...empty, breath: 1, qi: 12 })).toBe(3);
  });

  it('一块吐纳但存量还是 0：第 3 步条件没满足，退回第 1 步，下一帧由状态机自己抬到 2', () => {
    expect(resumeTutorialStep({ ...empty, breath: 1, qi: 0 })).toBe(1);
  });

  it('两块吐纳 → 第 4 步', () => {
    expect(resumeTutorialStep({ ...empty, breath: 2, qi: 40 })).toBe(4);
    expect(resumeTutorialStep({ ...empty, breath: 3, qi: 40 })).toBe(4);
  });

  it('心魔抬头 → 至少第 5 步', () => {
    expect(resumeTutorialStep({ ...empty, breath: 2, qi: 40, demon: 0.11 })).toBe(5);
    expect(resumeTutorialStep({ ...empty, breath: 0, qi: 0, demon: 0.5 })).toBe(5);
  });

  it('DEMON_HINT 是边界：正好 0.1 不抬', () => {
    expect(resumeTutorialStep({ ...empty, breath: 2, qi: 40, demon: DEMON_HINT })).toBe(4);
  });

  it('可渡劫 → 第 6 步（压过其它所有条件）', () => {
    expect(resumeTutorialStep({ ...empty, breath: 2, qi: 1_000, demon: 0.9, canBreakthrough: true })).toBe(6);
    expect(resumeTutorialStep({ ...empty, canBreakthrough: true })).toBe(6);
  });

  it('推导出来的步骤喂回状态机不会倒退：同一批事实下 nextTutorialStep 只往前走', () => {
    const cases = [
      { breath: 0, qi: 0, demon: 0, canBreakthrough: false },
      { breath: 1, qi: 12, demon: 0, canBreakthrough: false },
      { breath: 2, qi: 40, demon: 0.3, canBreakthrough: false },
      { breath: 2, qi: 40, demon: 0, canBreakthrough: true },
    ];
    for (const c of cases) {
      const derived = resumeTutorialStep(c);
      const sig: TutorialSignals = { breath: c.breath, calm: 0, qi: c.qi, demon: c.demon, hasCompare: true, pressedChallenge: false };
      expect(Number(nextTutorialStep(derived, sig, STEP4_DWELL_MS + 1))).toBeGreaterThanOrEqual(derived);
    }
  });
});

function memoryStorage(initial: Record<string, string> = {}): SaveStorage & { readonly dump: () => Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      map.set(key, value);
      return true;
    },
    remove: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
    dump: () => Object.fromEntries(map),
  };
}

describe('永久关闭只写一个键', () => {
  it('键名与值都钉住：验收 d 直接读 localStorage 这一项', () => {
    expect(TUTORIAL_KEY).toBe('gongfa:tutorial');
    expect(TUTORIAL_DONE).toBe('done');
    const storage = memoryStorage();
    expect(readTutorialDone(storage)).toBe(false);
    writeTutorialDone(storage);
    expect(storage.dump()[TUTORIAL_KEY]).toBe('done');
    expect(readTutorialDone(storage)).toBe(true);
  });

  it('别的值（手改的、半截的）都不算关闭：宁可多给一次引导', () => {
    expect(readTutorialDone(memoryStorage({ [TUTORIAL_KEY]: 'yes' }))).toBe(false);
    expect(readTutorialDone(memoryStorage({ [TUTORIAL_KEY]: '' }))).toBe(false);
  });
});
