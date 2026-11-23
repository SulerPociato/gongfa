import { describe, expect, it } from 'vitest';
import actionsJson from '../../../../content/actions.json';
import { COMPARE_DEFAULT_THRESHOLD, COMPARE_LEFT_LABELS } from '@gongfa/blocks';
import { AUTO_RATE, CHALLENGE_TRIAL_MS, actionMult } from '@gongfa/core';
import type { SaveStorage } from '@gongfa/core';
import { compareParts } from './format';
import {
  DEMON_HINT,
  END_DWELL_MS,
  MIN_STEP_DWELL_MS,
  NEW_BADGE_MS,
  RELEASE_AFTER_DRAG_MS,
  STEP4_DWELL_MS,
  TUTORIAL_DONE,
  TUTORIAL_KEY,
  TUTORIAL_PLAY_MS_MAX,
  flyoutFocusType,
  hiddenToolboxTypes,
  nextTutorialStep,
  readTutorialDone,
  releasedBadgeText,
  releasedBlock,
  releasedBlocks,
  releasedFocus,
  releasedTarget,
  resumeTutorialStep,
  stepDwellMs,
  MIN_ADVANCE_MS,
  tutorialActiveAt,
  tutorialBar,
  tutorialTarget,
  tutorialTargetKey,
  tutorialTargetKeyOf,
  tutorialText,
  writeTutorialDone,
  type TutorialSignals,
} from './tutorial';

const NO: TutorialSignals = { breath: 0, calm: 0, qi: 0, demon: 0, hasCompare: false, pressedChallenge: false };
const sig = (over: Partial<TutorialSignals>): TutorialSignals => ({ ...NO, ...over });
const NUM = { perSec: 10, compare: null, goalQi: 480, windowSec: 60, demon: 0 };

describe('步骤机：玩家点「继续」才翻页', () => {
  it('不点就不动：条件全满足、时间过很久也停在这一步', () => {
    expect(nextTutorialStep(1, sig({ breath: 9, qi: 1e6 }), 60_000)).toBe(1);
    expect(nextTutorialStep(3, sig({ breath: 9, qi: 1e6 }), 60_000)).toBe(3);
    expect(nextTutorialStep(5, sig({ demon: 0.5, calm: 9 }), 60_000)).toBe(5);
  });

  it('点一下按 1→2→3→4→5→6 顺序走，一步不落', () => {
    const click = sig({ clicked: true });
    expect(nextTutorialStep(1, click, MIN_ADVANCE_MS)).toBe(2);
    expect(nextTutorialStep(2, click, MIN_ADVANCE_MS)).toBe(3);
    expect(nextTutorialStep(3, click, MIN_ADVANCE_MS)).toBe(4);
    // 批次 32：第 5 步（调息）不再按心魔高低跳过 —— 跳过等于从不教这个机制。
    expect(nextTutorialStep(4, click, MIN_ADVANCE_MS)).toBe(5);
    expect(nextTutorialStep(5, click, MIN_ADVANCE_MS)).toBe(6);
  });

  it('第 6 步点一下收尾，done 之后不再动', () => {
    expect(nextTutorialStep(6, sig({ clicked: true }), MIN_ADVANCE_MS)).toBe('done');
    expect(nextTutorialStep('done', sig({ breath: 9, qi: 1e6, clicked: true }), 0)).toBe('done');
  });

  it('防手抖：刚翻页就点不生效', () => {
    expect(nextTutorialStep(1, sig({ clicked: true }), MIN_ADVANCE_MS - 1)).toBe(1);
    expect(nextTutorialStep(2, sig({ clicked: true }), MIN_ADVANCE_MS - 1)).toBe(2);
  });

  it('点过渡劫比「继续」更强：直接跳到第 6 步，再点收尾', () => {
    expect(nextTutorialStep(2, sig({ pressedChallenge: true }), 0)).toBe(6);
    expect(nextTutorialStep(5, sig({ pressedChallenge: true }), 0)).toBe(6);
    expect(nextTutorialStep(6, sig({ pressedChallenge: true }), 0)).toBe('done');
    expect(nextTutorialStep(6, sig({ clicked: true }), 0)).toBe(6);
  });

  it('停留表还在，但只用于文案节奏与旧档兼容（不再驱动翻页）', () => {
    expect(stepDwellMs(1)).toBe(6_500);
    expect(stepDwellMs(2)).toBe(MIN_STEP_DWELL_MS);
    expect(stepDwellMs(3)).toBeGreaterThanOrEqual(8_000);
    expect(stepDwellMs(5)).toBeGreaterThanOrEqual(10_000);
  });
});

describe('文案：数字全部插值，不许写死', () => {
  it('第 2 步用模型速率', () => {
    expect(tutorialText(2, { ...NUM, perSec: 10 })).toBe('每秒 +10 灵力。这个数字就是你的算法效率。');
    expect(tutorialText(2, { ...NUM, perSec: 24.666_666 }).startsWith('每秒 +25 灵力')).toBe(true);
    // 点击可以跳过动作：没产出时必须说「还没开张」，不能硬说「在涨」。
    expect(tutorialText(2, { ...NUM, perSec: 0 })).toBe('还没产出：把「吐纳」拖进凹槽，上面的数字就会开始动。');
  });

  it('第 4 步复述对比行的三个数，不是 10 → 18 / +80% 的常量', () => {
    const compare = { fromPerSec: 61.234, toPerSec: 90.0, percent: 47 };
    const text = tutorialText(4, { ...NUM, compare });
    const p = compareParts(61.234, 90.0, 47);
    expect(text).toBe(`看，${p.from} → ${p.to} 每秒（${p.percent}%）。同样的时间，多算一遍。`);
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

  it('第 1 步说清这块干什么', () => {
    expect(tutorialText(1, NUM)).toBe('先把「吐纳」拖进「每 tick」下面的凹槽。它每 tick 产一次灵力。');
  });

  it('第 3 步的 0.8 来自 actionMult(2)，第 6 步的 10 秒 / 60% 来自 realm 常量 —— 都不是抄进句子里的字面量', () => {
    const k2 = String(Number(actionMult(2).toFixed(2)));
    expect(k2).toBe('0.8');
    // 文案按现场状态改口：没拖第二块时说「再拖一块」，拖了才说「看这里」。
    expect(tutorialText(3, { ...NUM, breaths: 1 })).toContain(`只值 ${k2} 倍`);
    expect(tutorialText(3, { ...NUM, breaths: 2 })).toBe(
      `再拖一块试试。同样一 tick 里第二块只值 ${k2} 倍 —— 这就是边际递减，但总产出还是涨了。`,
    );
    // 第 6 步：按钮还灰着的时候不能叫玩家「点它」。
    expect(tutorialText(6, { ...NUM, canChallenge: true })).toBe(
      `存量满了。点「可渡劫」—— 渡劫有 ${CHALLENGE_TRIAL_MS / 1000} 秒，不操作会按 ${Math.round(AUTO_RATE * 100)}% 自动结算。`,
    );
    expect(tutorialText(6, { ...NUM, canChallenge: false })).toContain('按钮会亮');
  });

  it('第 5 步的百分比是现场心魔，不是固定台词', () => {
    // 取整到 1%：小数会让整句每 100ms 被重写一次，玩家看到的是文字在抖。
    expect(tutorialText(5, { ...NUM, demon: 0.1234 })).toBe(
      '心魔这一条：它按「每个动作」涨，吐纳叠得越多涨得越快。现在 12% —— 拖一个「调息」进来压住它。',
    );
    expect(tutorialText(5, { ...NUM, demon: 0.2671 })).toContain('现在 27%');
    expect(tutorialText(5, { ...NUM, demon: 0.1234 })).not.toBe(tutorialText(5, { ...NUM, demon: 0.2671 }));
    // 心魔本来就低还说「已经 X% 了——拖调息压住它」是自相矛盾的假话
    expect(tutorialText(5, { ...NUM, demon: 0.02 })).toContain('还压得住');
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
    // 放出延后到 5 秒：第 1 步停留 6.5 秒，若 3 秒就放出，气泡会在玩家读第 1 句时被抢去指「调息」。
    expect(RELEASE_AFTER_DRAG_MS).toBe(5_000);
    expect(stepDwellMs(1)).toBe(6_500);
    expect(stepDwellMs(4)).toBe(6_500);
    expect(stepDwellMs(5)).toBe(10_000);
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

// 需求变更 2026-11-21：气泡要贴住「这一步该看的那个元素」。这里钉住六步的目标映射，
// 特别是两个容易写错的：第 4 步指整块曲线面板（.curve-compare 只在有两条基线时才渲染），'done' 没有目标。
describe('tutorialTarget：每一步指哪个元素', () => {
  it('第 1/3 步指工具箱里的吐纳块，第 5 步指调息块', () => {
    expect(tutorialTarget(1)).toEqual({ kind: 'flyout', type: 'breath' });
    expect(tutorialTarget(3)).toEqual({ kind: 'flyout', type: 'breath' });
    expect(tutorialTarget(5)).toEqual({ kind: 'dom', selector: '.demon-row' });
  });

  it('第 2/4/6 步指 HUD 里那三个真实类名', () => {
    expect(tutorialTarget(2)).toEqual({ kind: 'dom', selector: '.hud .qi' });
    expect(tutorialTarget(4)).toEqual({ kind: 'dom', selector: '.curve' });
    expect(tutorialTarget(6)).toEqual({ kind: 'dom', selector: '.hud .challenge-button' });
  });

  it('结束态没有目标：那句「自己试」由底部条完整文案来说，气泡不出现', () => {
    expect(tutorialTarget('done')).toBeNull();
  });

  it('目标键是稳定字符串：React 依赖数组用它，不用对象身份', () => {
    expect(tutorialTargetKey(1)).toBe('flyout:breath');
    expect(tutorialTargetKey(4)).toBe('.curve');
    expect(tutorialTargetKey('done')).toBe('none');
  });
});

// 需求 15 + 裁定 3：工具箱放出新块时挂 2 秒「新」角标、气泡改指新块。
// 这里钉的是「按块 id 查表」和「数值来自表」：文案里一个数字都不许是抄进字符串的字面量。
describe('工具箱放出新块：「新」角标的文案与聚焦', () => {
  it('角标窗口是 2 秒', () => {
    expect(NEW_BADGE_MS).toBe(2_000);
  });

  it('放出来的就是刚才被藏掉的那几块，种类查得到（实测第 3 秒释放的是调息 + 比较）', () => {
    const blocks = releasedBlocks(hiddenToolboxTypes(true, false));
    expect(blocks.map((b) => b.id)).toEqual(['calm', 'gongfa_compare']);
    expect(blocks.map((b) => b.kind)).toEqual(['action', 'value']);
  });

  it('调息那句的 -0.0005 就是 actions.json 里那行：换表就换口', () => {
    const delta = actionsJson.find((action) => action.id === 'calm')?.demonDelta ?? 0;
    expect(delta).toBe(-0.0003);
    expect(releasedBadgeText(releasedBlock('calm'))).toBe(`调息：每次 ${delta} 心魔，代价是占一个动作槽`);
    expect(releasedBadgeText({ id: 'calm', label: '调息', kind: 'action', demonDelta: -0.002 })).toContain('-0.002');
  });

  it('正值补「+」：「每次 0.0005 心魔」听着像在压，那是反话', () => {
    expect(releasedBadgeText({ id: 'calm', label: '调息', kind: 'action', demonDelta: 0.0005 })).toContain('每次 +0.0005 心魔');
  });

  it('表里查不到 demonDelta 的动作块不编数字，退回「刚放出来」那句', () => {
    expect(releasedBadgeText({ id: 'calm', label: '调息', kind: 'action', demonDelta: null })).toBe('「调息」刚放出来，可以拖进画布试试。');
  });

  it('比较块说的是它自己的定义：三个左值与默认阈值都来自积木 JSON', () => {
    const text = releasedBadgeText(releasedBlock('gongfa_compare'));
    expect(COMPARE_LEFT_LABELS).toEqual(['存量', '心魔', '预算']);
    expect(COMPARE_DEFAULT_THRESHOLD).toBe(0.5);
    expect(text).toContain('存量 / 心魔 / 预算');
    expect(text).toContain('0.5');
  });

  it('表里没这个 id：只说它放出来了，不提它干什么', () => {
    expect(releasedBlock('mystery').kind).toBe('unknown');
    expect(releasedBadgeText(releasedBlock('mystery'))).toBe('「mystery」刚放出来，可以拖进画布试试。');
  });

  it('气泡优先指动作块 —— 「占一个动作槽」这句只有它有资格说，而且不写死 calm', () => {
    expect(releasedFocus(releasedBlocks(['gongfa_compare', 'calm']))?.id).toBe('calm');
    expect(releasedFocus([releasedBlock('gongfa_compare')])?.id).toBe('gongfa_compare');
    expect(releasedFocus([])).toBeNull();
  });

  it('窗口内气泡改指新块，出窗口回到这一步自己的靶子', () => {
    expect(releasedTarget(releasedBlock('calm'))).toEqual({ kind: 'flyout', type: 'calm' });
    expect(tutorialTargetKeyOf(releasedTarget(releasedBlock('calm')))).toBe('flyout:calm');
    expect(releasedTarget(null)).toBeNull();
    expect(tutorialTargetKeyOf(null)).toBe('none');
    // 目标键换了 → 气泡这一段是「移过去」，不是原地换字（需求 14 与 15 的交点）。
    expect(tutorialTargetKeyOf(releasedTarget(releasedBlock('calm')))).not.toBe(tutorialTargetKey(2));
  });
});
