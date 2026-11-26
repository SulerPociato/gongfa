import { useEffect, useRef, useState } from 'react';
// 只引 blockly/core：blockly 主入口会顺带注册标准库积木（controls_*、logic_*），我们用不到它们，
// 引了还会和自定义块型抢注册、往 console 刷覆盖警告。
import * as Blockly from 'blockly/core';
import * as zhHans from 'blockly/msg/zh-hans';
import {
  BLOCK_DEFINITIONS,
  BLOCK_SPECS,
  PROGRAM_ID,
  compileWorkspace,
  suggestRewrite,
  GONGFA_THEME,
  STARTER_WORKSPACE_JSON,
  TOOLBOX_JSON,
  type WorkspaceJson,
} from '@gongfa/blocks';
import { AUTO_RATE, BACKLASH_LINE, FAILURE_QI_MULT, NOISE_LINE, PARRY_BONUS, PARRY_DEMON_RELIEF, PARRY_MISS_DEMON, PARRY_PENALTY, PARRY_RATE_MAX, PARRY_RATE_MIN, PREVIEW_SECONDS, PATTERN_TOTAL, PATTERNS, TRIAL_WAVES_MS, activeSlot, bookEvent, derivePhase, linearizeProgram, loadGame, newGameState, patternDef, patternsOf, readSettings, shapeOf, writeSettings, type BookDef, type BookEvent, type BookPhase, type CurvePreview, type GameState, type LoadResult, type OfflineResult, type PatternId, type Program, type SaveStorage, Qi } from '@gongfa/core';
import { blockLocalStorageWrites, createLocalStorageSaveStorage, createSessionFlagStore, wallClock } from './adapters/storage';
import { randomSeed } from './adapters/seed';
import { createSaveController, type SaveSnapshot } from './game/save';
import { createRuntime, urlSeed, CALM_DEMON_DELTA, type ChallengeResult, type Runtime, type RuntimeState } from './game/runtime';
import { clearGongfaKeys, consumeDemoReset, requestDemoReset } from './game/demo';
import { RESET_CONFIRM_TEXT, resetAllSaves } from './game/reset';
import { DEMO_SPEED } from './game/demo';
import { createLoop } from './game/loop';
import { BOOK_CATALOGUE, STARTER_BOOK_ID, bookById, grantStarterBook } from './game/books';
import { ARTIFACT_CATALOGUE, describeArtifact, equipmentFor } from './game/artifacts';
import { lockedCount, MIN_REALM, toolboxForRealm } from './game/toolbox';
import { END_DWELL_MS, NEW_BADGE_MS, RELEASE_AFTER_DRAG_MS, TUTORIAL_PLAY_MS_MAX, flyoutFocusType, hiddenToolboxTypes, nextTutorialStep, readTutorialDone, releasedBlocks, resumeTutorialStep, tutorialActiveAt, tutorialBar, writeTutorialDone, type ReleasedBlock, type TutorialBarModel, type TutorialNumbers, type TutorialPlayStep, type TutorialStep } from './game/tutorial';
import { readFound, writeFound } from './game/found';
import { readUnlocked, writeUnlocked } from './game/unlocked';
import { Modal, type ModalRequest } from './game/Modal';
import { MOMENT_TEXTS, PERSISTED_MOMENTS, readSeenActive, writeSeen, type MomentId } from './game/moments';
import { nextStepOf } from './game/nextStep';
import { palettePlacement } from './game/palette';
import { RENDERER_NAME } from './game/blockSkin';
import { clearPity, readPity, writePity } from './game/pity';
import { readDao, writeDao } from './game/dao';
import { readBest, writeBest, type BestMap } from './game/best';
import { insightBonusText, insightRate, rankReached } from './game/insight';
import { errandOf } from './game/errand';
import { SCRIPTURES, canLearn, missingBlocks, missingBlocksIn, missingPatterns, scriptureOf } from './game/scriptures';
import { readInsight, readLearned, readAwarded, writeInsight, writeLearned, writeAwarded } from './game/insightStore';
import { insightFromSources, insightValueOf, missingSources, patternSource, sourceIds, trialSource } from './game/insightSources';
import { FORMATIONS, formationOf, mergeFormation } from './game/formations';
import { ChallengeResultLayer, CoachBanner, Hud, TrialPanel, TutorialBar, type ArtifactRow, type BookAction, type BookModel, type ChallengeModel, type ChallengeOutcome, type ChallengePhase, type CorruptLineModel, type CurveCompare, type CurveModel, type FormationRow, type HudModel, type RealmModel, type RetreatReport, type ScriptureRow, type SprintModel } from './game/hud';
import { TutorialBubble } from './game/tutorialBubble';
import { WorldCodex } from './game/WorldCodex';
import { AlgorithmCard } from './game/AlgorithmCard';
import { QiParticles } from './components/QiParticles';

type InjectOptions = NonNullable<Parameters<typeof Blockly.inject>[1]>;
type ThemeConfig = Parameters<typeof Blockly.Theme.defineTheme>[1];
type SerializedState = Parameters<typeof Blockly.serialization.workspaces.load>[0];
type SaveBridge = ReturnType<typeof createSaveController>;

// 空画布装载的程序：与 compileWorkspace 对「空凹槽」的产物同形（只有一条 HALT）。
const EMPTY_CANVAS_PROGRAM: Program = { id: PROGRAM_ID, code: [{ op: 'HALT' }] };

// 需求 15：不在「新块角标」窗口内时的那份空列表。用同一个常量而不是每次新建 ——
// 数组身份一变，TutorialBubble 的 effect 就重建，气泡白重测一次几何。
const NO_RELEASE: readonly ReleasedBlock[] = [];

// D5：验收与回放用的只读句柄（state() 的实时视图，含 noiseTicks / backlashTicks / tick）。
// 只在 DEV 或 ?debug=1 时挂，正式构建默认不挂；卸载时删掉，不留上一份会话的 runtime。
declare global {
  interface Window {
    __gongfa_debug?: {
      readonly state: () => RuntimeState;
      readonly settleOffline?: (lastSeenAt: number) => OfflineResult | null;
      readonly hideFlyout?: () => void;
    } | undefined;
  }
}

// 进度条和文案共用的境界视图：字段全部来自 runtime.state()，HUD 侧不做任何算术。
// 调息那句（P0-C 第 6 项）走 CALM_DEMON_DELTA —— actions.json 里 calm 那行的原值，
// 表改成 -0.001 这行就跟着变；表里没有调息就整句不出现，不印一个「-0/次」冒充。
function realmModel(state: RuntimeState, found: readonly PatternId[]): RealmModel {
  return {
    name: state.realmName,
    threshold: state.threshold,
    passivePerSec: state.passivePerSec,
    canBreakthrough: state.canBreakthrough,
    pauseRemainingMs: state.pauseRemainingMs,
    demon: state.demon,
    lingGen: state.lingGen,
    pillCooldownMs: state.pillCooldownMs,
    calmText: CALM_DEMON_DELTA === null ? null : `调息 ${CALM_DEMON_DELTA}/次`,
    patterns: PATTERNS.map((pattern) => ({
      id: pattern.id,
      name: pattern.name,
      algorithm: pattern.algorithm,
      requires: pattern.requires,
      teach: pattern.teach,
      found: found.includes(pattern.id),
    })),
    dao: state.dao,
    patternsBonus: insightBonusText(found.length),
    errandGoal: errandOf(state.realmIndex, state.stepsThisTick > 0 ? state.rate / 10 / state.stepsThisTick : 0).goal,
    perQi: state.stepsThisTick > 0 ? state.rate / 10 / state.stepsThisTick : 0,
    errandMet: errandOf(state.realmIndex, state.stepsThisTick > 0 ? state.rate / 10 / state.stepsThisTick : 0).met,
  };
}

// 渡劫相位的推导顺序就是玩家看到的优先级（契约 §7.1 / §7.3）：
// 挑战中 > 末境 > 存量没到 > 蓄势没到点 > 冷却没走完 > 可渡劫。
// 冷却排在蓄势之后：60 秒短于最短的蓄势窗口（筑基起 2 分钟），先到期的那条才是玩家此刻该等的东西。
function challengePhaseOf(state: RuntimeState): ChallengePhase {
  if (state.challengeActive) return 'trial';
  if (state.nextRealmName === null) return 'final';
  if (!state.canBreakthrough) return 'threshold';
  if (state.chargeRemainingMs > 0) return 'charge';
  if (state.cooldownRemainingMs > 0) return 'cooldown';
  return 'ready';
}

// 试炼（契约 §7.1.1）：四个数全部现取自 runtime —— 目标查表、进度是滑动窗口、reached 是本境界的一次性布尔。
// 这里不做「还差多少」「减半成几秒」的算术，HUD 拿到什么就写什么。
function sprintModel(state: RuntimeState, bestPerQi: number | null = null): SprintModel {
  return {
    goalQi: state.sprintGoalQi,
    progressQi: state.sprintProgressQi,
    windowMs: state.sprintWindowMs,
    reached: state.sprintReached,
    steps: state.sprintSteps,
    perQi: state.sprintPerQi,
    bestPerQi,
    perQiGoal: errandOf(state.realmIndex, 0).goal ?? 0,
    excellent: state.sprintReached
      && state.sprintPerQi >= (errandOf(state.realmIndex, 0).goal ?? Number.POSITIVE_INFINITY),
  };
}

function challengeModel(state: RuntimeState): ChallengeModel {
  return {
    phase: challengePhaseOf(state),
    // 冷却与蓄势都归零才算就绪；挑战进行中允许再点一次（那一次就是手动确认，85%）。
    enabled: state.canChallenge,
    nextRealmName: state.nextRealmName,
    // 渡劫面板的标题「渡劫 · 炼气 → 筑基」要当前境名；runtime 已经给了，不再回头查表拼第二份口径。
    realmName: state.realmName,
    chargeRemainingMs: state.chargeRemainingMs,
    trialRemainingMs: state.trialRemainingMs,
    // 批次 38：承雷战绩直接透传，HUD 不自己数。
    trialParry: state.trialParry,
    cooldownRemainingMs: state.cooldownRemainingMs,
    attempt: state.attempt,
    insight: state.insight,
  };
}

// 工具箱这一栏的说明：§4.3 的门控是内容设计，被挡住几块要当场说出来，别让玩家以为少件。
// 总数在这里算一次：全开的 contents 就是「这套积木一共有几块」，不写死 5。
const TOOLBOX_COUNT = toolboxForRealm(0, true).contents.length;

function toolHintOf(state: RuntimeState): string {
  const locked = lockedCount(state.realmIndex, state.demo);
  if (state.demo) return `演示模式 · 工具箱全开（筑基的 ${lockedCount(state.realmIndex, false)} 块正式玩法要突破后才给）`;
  if (locked === 0) return `工具箱 · ${state.realmName}已给齐全部 ${TOOLBOX_COUNT} 块`;
  return `工具箱 · ${state.realmName}还差 ${locked} 块（筑基起给「如果 / 循环」）`;
}

// 道具面板的行 = 目录里的每一件 × 当前装备位。数值全靠 describeArtifact 从表里拼，
// 这里不另写 0.7 / +50：表改了面板还在说旧数，就是第二份口径。
// 批次 20：道具按境界解锁。原来五件一开局全都能装，玩家既不知道哪件有用，
// 也不知道「为什么现在装不了」——解锁条件直接写在按钮上。
const ARTIFACT_UNLOCK: Readonly<Record<string, { readonly realm: number; readonly label: string }>> = {
  jade: { realm: 0, label: '炼气' },
  abacus: { realm: 0, label: '炼气' },
  pearl: { realm: 1, label: '筑基' },
  vase: { realm: 1, label: '筑基' },
  pouch: { realm: 2, label: '金丹' },
};

// 批次 22：道具改成「掉落获得」。原来按境界自动可装，玩家既没有获得的瞬间，
// 也就没有「这件东西是打赢来的」这层意义。
const ARTIFACT_DROPS: Readonly<Record<number, readonly string[]>> = {
  1: ['abacus'],
  2: ['pearl', 'pouch'],
  3: ['vase'],
};

function artifactRows(equippedIds: readonly string[], realmIndex: number, ownedIds: readonly string[]): readonly ArtifactRow[] {
  return ARTIFACT_CATALOGUE.artifacts.map((artifact) => {
    const unlock = ARTIFACT_UNLOCK[artifact.id];
    const realmLocked = unlock !== undefined && realmIndex < unlock.realm;
    const owned = ownedIds.includes(artifact.id);
    return {
      id: artifact.id,
      name: artifact.name.zh,
      effect: describeArtifact(artifact),
      equipped: equippedIds.includes(artifact.id),
      locked: realmLocked || !owned,
      unlockHint: realmLocked ? `${unlock?.label ?? ''}解锁` : '未获得 · 渡劫掉落',
      when: ARTIFACT_GUIDE.find((row) => row.id === artifact.id)?.when ?? '',
    };
  });
}

// 每次 state() 都要重建整份 HudModel：book / corrupt / save / notices 这些跟帧无关的视图存在 view 里，
// 帧只换 qi / rate / stall / realm / challenge / toolHint 六件套。
// artifacts 也属于「跟帧无关」那一类：只有点开关时才变，所以由 syncArtifacts 直接写进 view，不走这里。

// 离线结算报告暂存：StrictMode 双挂载时，第一次挂载的结算结果要在第二次挂载时显示。
// 模块级变量在两次挂载之间存活，第二次挂载读取后清空。
let pendingOfflineReport: OfflineResult | null = null;

/**
 * 结算结果 → 闭关报告。三处调用共用（启动、后台空窗 §1 R3、debug 句柄）。
 * 境界名取当前 state()：离线突破成功时它已经是新境界，报告不能写结算前的旧名。
 */
function toRetreatReport(result: OfflineResult, realmName: string): RetreatReport {
  const hit = result.breakthroughs[0];
  return {
    elapsedMs: result.elapsedMs,
    creditedGained: result.creditedGained,
    rawGained: result.rawGained,
    realmName,
    breakthrough: hit === undefined ? null : { realm: hit.realm, ok: hit.ok },
  };
}

// 曲线预览的空视图：编译失败或凹槽空着时整块面板不出现 —— 画一条没在跑的曲线是假话。
const NO_CURVE: CurveModel = { points: [], threshold: 0, etaSec: null, reachesInWindow: false, seconds: PREVIEW_SECONDS, compare: null, truncated: false, demon: [], demonMax: BACKLASH_LINE, backlashAtSec: null };

// toast 的停留时长：要够读完一句话，又不至于挡在玩家眼前不走（HUD 窄栏没有别的东西可看）。
const TOAST_MS = 6_000;

// 渡劫结果层的两段时长（批次 1 验收 6/9）：1.2 秒金色符箓展开 + 展开后再停 1.5 秒。
// HOLD 同时是「点击跳过」的闸门：结算那一下玩家的手常常还压在按钮上，
// 若一出现就能点，动画会被同一连击秒掉 —— 那不是反馈，是闪屏。所以不满 1.5 秒的点击必须整次忽略。
const RESULT_TALISMAN_MS = 1_200;
const RESULT_HOLD_MS = 1_500;

// 预览结果 → 面板模型：窗口秒数从 core 的常量取，对比行走的是模型速率（同一份程序不许有两个「每秒」）。
function curveModel(preview: CurvePreview, compare: CurveCompare | null): CurveModel {
  return {
    points: preview.points,
    threshold: preview.threshold,
    etaSec: preview.etaSec,
    reachesInWindow: preview.reachesInWindow,
    seconds: PREVIEW_SECONDS,
    compare,
    truncated: preview.truncated,
    demon: preview.demonPoints,
    // 右轴满刻度 = 火线，从 core 传：HUD 写死 1 的话，改阈值那天面板会自己画出一条不存在的线。
    demonMax: BACKLASH_LINE,
    backlashAtSec: preview.backlashAtSec,
  };
}

// 批次 5：境界解锁的 toast 文案。文案里的块名从 BLOCK_SPECS 取，不写死。
const UNLOCK_TOAST_TEXTS: Readonly<Record<string, string>> = {
  gongfa_break: '解锁：中断 —— 立刻跳出循环，找到就不必再算',
  gongfa_continue: '解锁：继续 —— 跳过本轮剩下的动作，直接下一轮',
  gongfa_while: '解锁：重复直到 —— 条件满足才停，次数由你定',
};
function getUnlockToastText(blockId: string): string {
  return UNLOCK_TOAST_TEXTS[blockId] ?? `解锁：${BLOCK_SPECS[blockId]?.label ?? blockId}`;
}

// 批次 6：道具指南（设置抽屉里）。effect 与 content/artifacts.json 的措辞对齐，
// "什么时候用" 是玩家真正会问的那句 —— 没有它，两件道具就是两个不知道何时开的关键字。
const ARTIFACT_GUIDE: readonly { readonly id: string; readonly glyph: string; readonly name: string; readonly effect: string; readonly when: string }[] = [
  {
    id: 'jade',
    glyph: '玉',
    name: '玉简',
    effect: '同一 tick 内重复执行的相同动作产出 ×0.7，但那一步不占预算',
    when: '筑基后开始用「循环」重复同一动作时。动作重复得越多，省下的步数越明显；只跑一遍的程序它没有作用',
  },
  {
    id: 'abacus',
    glyph: '算',
    name: '算盘',
    effect: '每 tick 指令预算 +50 步（200 → 250）',
    when: '程序撞上预算、HUD 出现「第 N 步没跑完」时。它不提高效率，只让你能多算几步',
  },
  {
    id: 'pearl',
    glyph: '珠',
    name: '灵珠',
    effect: '全产出 ×1.10（动作产出与境界被动都算）',
    when: '任何时候都有效，但它是乘数不是加法：基础速率越高，收益越大',
  },
  {
    id: 'pouch',
    glyph: '袋',
    name: '储物袋',
    effect: '缓存槽位 +1（玉简默认只记 1 种动作，现在能记 2 种）',
    when: '程序里交替使用吐纳和调息、玉简经常「记不住」上一次时。它不加快单次动作，只让缓存不被挤掉',
  },
  {
    id: 'vase',
    glyph: '瓶',
    name: '玉净瓶',
    effect: '心魔增速 ×0.90',
    when: '心魔经常越过 70%、杂念频繁时。它不改你的产出，只让心魔涨得慢一点',
  },
];

// moment 的 id 与"解锁块 id"共用一条队列（unlockToasts），这里按 id 分派文案：
// 先查 moment 表，再查解锁表——两边的 id 空间不重叠（moment 是英文事件名，块 id 是 gongfa_ 前缀）。
// 需要带实时数字的 moment（试炼评分）在入队前把整句写进 overrides，表里只留固定句式。
const momentTextOverrides = new Map<string, string>();
function momentToastText(id: string): string {
  const override = momentTextOverrides.get(id);
  if (override !== undefined) return override;
  const moment = (MOMENT_TEXTS as Readonly<Record<string, string>>)[id];
  return moment ?? getUnlockToastText(id);
}

function hudModel(state: RuntimeState, book: BookModel, found: readonly PatternId[], extra: Pick<HudModel, 'errors' | 'corrupt' | 'warning' | 'save' | 'notices' | 'artifacts' | 'retreat' | 'curve' | 'toast' | 'tutorial' | 'nextStep' | 'dao' | 'formations' | 'scriptureSources'> & { readonly bestPerQi: number | null }): HudModel {
  return {
    qi: Math.floor(state.qi),
    rate: state.rate,
    stall: state.stall,
    // 批次 5：步数经济学。perQi = 本 tick 产出 ÷ 本 tick 步数，0 步时不显示（空程序不是"效率 0"）。
    steps: {
      used: state.stepsThisTick,
      pool: state.budgetPool,
      perQi: state.stepsThisTick > 0 ? state.rate / 10 / state.stepsThisTick : 0,
    },
    realm: realmModel(state, found),
    curve: extra.curve,
    sprint: sprintModel(state, extra.bestPerQi),
    challenge: challengeModel(state),
    toolHint: toolHintOf(state),
    artifacts: extra.artifacts,
    book,
    errors: extra.errors,
    corrupt: extra.corrupt,
    warning: extra.warning,
    save: extra.save,
    notices: extra.notices,
    retreat: extra.retreat,
    toast: extra.toast,
    tutorial: extra.tutorial,
    demo: state.demo,
    nextStep: extra.nextStep,
    dao: extra.dao,
    formations: extra.formations,
    scriptureSources: extra.scriptureSources,
    trace: state.trace,
    quest: [],
    furnaceReady: false,
    scriptureHighlight: false,
    insight: 0,
    scriptures: [],
    palette: toolboxForRealm(state.realmIndex, state.demo).contents.map((item) => item.type),
  };
}

// 块定义与语言包是 Blockly 的进程级单例：放模块顶层只执行一次，
// 放 useEffect 里会被 StrictMode 的双挂载二次注册（Blockly 对重复 type 直接报错）。
Blockly.setLocale(zhHans as unknown as Parameters<typeof Blockly.setLocale>[0]);
Blockly.defineBlocksWithJsonArray(BLOCK_DEFINITIONS as unknown as Parameters<typeof Blockly.defineBlocksWithJsonArray>[0]);

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clockText(ms: number): string {
  const at = new Date(ms);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

// 「详情」里的备份原文截断到此长度：整份 JSON 能有三千字，HUD 那块地方放不下。
const BACKUP_TEXT_CHARS = 2000;

// 程序化换画布（读档、装载/卸下/放弃修改）给这一批事件盖个组号。
// Blockly 的 serialization.load 不在同步栈里发事件（实测：调用返回时 0 条，全在下一个宏任务），
// 所以「reloading 布尔 + 同步复位」罩不住它们；只有事件自带的组号能区分「玩家改的」和「我们换的」。
const PROGRAMMATIC_GROUP = 'gongfa:programmatic';

/** addChangeListener 回调收到的事件，这里只用到组号 */
type ChangeEvent = { readonly group?: string | undefined };

// 存档损坏提示分层：HUD 只留 core 那一句「已备份为 …，已开新档」，
// 逐字段明细 + 备份原文进 console.group('save:corrupt') 和「详情」展开区。
// 回退备用槽成功（state 还在）不走这里：档读回来了，core 那时 errors 为空，只有一句灰字 notice。
let pendingCorrupt: CorruptLineModel | null = null;

// 回退备用槽的提示也走同一个「跨重挂载」兜底：StrictMode 第二次挂载时，第一次可能已经把 B 槽写成指针，
// 再读就是「一切正常」——提示就这么被吞了（HANDOFF 第 4 条坑的同型问题）。
// 生产构建只挂一次，模块变量不会被读到，不影响。
let pendingFallbackNotice: string | null = null;
// 悟道补发也跨一次重挂载：第一次挂载已经把账本写满，第二次算出来是 0，提示会消失。
let pendingBackfillNotice: string | null = null;

function corruptReport(storage: SaveStorage, loaded: LoadResult): CorruptLineModel | null {
  if (loaded.state !== null || loaded.summary === null) return null;

  const backup = loaded.corruptedKey === null ? null : storage.read(loaded.corruptedKey);
  const detail = backup === null || backup === ''
    ? [...loaded.errors]
    : [...loaded.errors, `备份 ${loaded.corruptedKey} 原文：`, backup.slice(0, BACKUP_TEXT_CHARS)];
  console.group('save:corrupt');
  console.warn(loaded.summary);
  for (const message of detail) console.warn(message);
  console.groupEnd();
  pendingCorrupt = { line: loaded.summary, detail };
  return pendingCorrupt;
}


export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const saveRef = useRef<SaveBridge | null>(null);
  // 四个功法书按钮的实现在 useEffect 里才拿得到 workspace 与存档控制器，这里只留一个转发口。
  const bookActionRef = useRef<((action: BookAction) => void) | null>(null);
  // 「可渡劫」按钮同理：runtime 在 useEffect 里才和存档控制器配上，这里只留转发口。
  const challengeActionRef = useRef<(() => void) | null>(null);
  // 道具开关同理：装备要当场重算 sink 与预算池，只有 useEffect 里才摸得到 runtime 与控制器。
  const artifactActionRef = useRef<((id: string) => void) | null>(null);
  const pillActionRef = useRef<(() => void) | null>(null);
  // 批次 15：引导「继续」按钮转发（effect 闭包里的 tutClicked 只能这样改）。
  const tutAdvanceRef = useRef<(() => void) | null>(null);
  // 批次 19：窄屏积木库 —— 点一下就加一块，不依赖 Blockly 的侧边飞行栏。
  const addBlockRef = useRef<((type: string) => void) | null>(null);
  // 批次 28：藏经阁（学功法 / 抄录）。
  const learnScriptureRef = useRef<((id: string) => void) | null>(null);
  const loadScriptureRef = useRef<((id: string) => void) | null>(null);
  // 阵法阁（2026-11-26）：拓印 = 追加到现有功法，不替换现有引灵。
  const traceFormationRef = useRef<((id: string) => void) | null>(null);
  // P1 纵切：炼器炉。分析要用 effect 闭包里的 saved/compile，所以同样走 ref 转发。
  const optimizeActionRef = useRef<(() => void) | null>(null);
  // 底部引导条的「跳过引导」同理：要写 localStorage、放掉工具箱的隐藏块，全在 useEffect 的作用域里。
  const tutorialSkipRef = useRef<(() => void) | null>(null);
  // 需求 13 的起表报告：实现挂在 useEffect 作用域里，这里只留一条身份稳定的转发函数当 prop ——
  // 气泡的起表 effect 直接依赖它，每次渲染换新函数等于每帧重排一次绘制回调。
  const tutPaintedRef = useRef<((step: TutorialPlayStep) => void) | null>(null);
  const onTutPainted = useRef((step: TutorialPlayStep): void => { tutPaintedRef.current?.(step); }).current;
  // 种子只在这里掷一次，新档的 GameState 与 runtime 都从 runtime.state().seed 取同一个值。
  // ?seed= 优先（验收 5 要同种子复现）；有存档时 restore() 把 seed 换成存档里那份。
  // 渡劫结算和蓄势起算都要立刻标脏 —— chargeReadyAt 不落盘，刷新就得重新等满 2 分钟。
  // markDirty 走 saveRef 现取：控制器要到 useEffect 里才建出来，构造时只能留一个晚绑定的闭包。
  // 空窗离线结算（契约 §1 R3）的回调也一样晚绑定：setHud / runtimeRef 在构造那一刻才刚就位，
  // 但回调只在 run() 里触发，那时两者都已初始化。
  // allowBreakthrough 每次现读设置：玩家中途关掉「离线渡劫」不该还按旧值掷骰。
  if (runtimeRef.current === null) {
    runtimeRef.current = createRuntime({
      seed: urlSeed() ?? randomSeed(),
      // 道途是元进度（gongfa:dao:<slot>），开局读一次交给 runtime：
      // 产出倍率在 run() 里现读，心魔基数在 sink 构造时固定。
      dao: readDao(createLocalStorageSaveStorage()),
      markDirty: () => saveRef.current?.markDirty(),
      allowBreakthrough: () => readSettings(createLocalStorageSaveStorage()).settings.offlineBreakthrough,
      onOfflineReport: (result) => {
        const rt = runtimeRef.current;
        // 用 state() 而不是 HUD 上一帧的境界名：离线突破成功时报告要显示新境界（契约 §7.2）
        if (rt !== null) setHud((previous) => ({ ...previous, retreat: toRetreatReport(result, rt.state().realmName) }));
      },
    });
  }
  const booted = runtimeRef.current.state();
  const initialSettings = readSettings(createLocalStorageSaveStorage());
  const [hud, setHud] = useState<HudModel>(hudModel(booted, { phase: 'IDLE', text: '未装载功法 · 心魔 ×1.00', loadable: 0 }, [], { errors: [], corrupt: null, warning: null, save: ['读取存档…'], notices: [], artifacts: [], retreat: null, curve: NO_CURVE, toast: null, tutorial: null, nextStep: '', dao: null, formations: [], scriptureSources: '', bestPerQi: null }));
  const [settings, setSettings] = useState(initialSettings.settings);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 批次 29：第一次拿到悟道时点亮藏经阁（2.6 秒后自动熄）。
  // 逐帧回调只认首帧闭包，所以用 ref 而不是 state。
  const scriptureHighlightRef = useRef(false);
  // 批次 33：起步卡（引导结束后的下一步）。关掉就这一会话不再出现。
  const [coachDismissed, setCoachDismissed] = useState(false);
  // 批次 35：右侧只留必要信息，其余进「面板」sheet。
  const [panelOpen, setPanelOpen] = useState(false);
  const coachRef = useRef<{ text: string } | null>(null);
  // 试炼最佳效率（元进度 gongfa:best:<slot>）。读档在 effect 里做（storage 那时才建），
  // 这里只存一份内存镜像给 HUD 用；境界切换时按 realmIndex 取。
  const [bestMap, setBestMap] = useState<BestMap>({});
  // 逐帧回调里的闭包只认首帧的 bestMap（永远空），所以再存一份 ref 给循环读。
  const bestMapRef = useRef<BestMap>({});
  // 引导气泡（需求变更 2026-11-21）：贴得上目标 → 底部条降级成「n/6 · 跳过引导」；贴不上 → 底部条说完整文案。
  const [tutPlaced, setTutPlaced] = useState(false);
  // 「工具箱重建过了」的计数：updateToolbox 换掉整棵 flyout DOM，气泡要立刻重挂高亮，不等 400ms 轮询。
  const [tutRev, setTutRev] = useState(0);
  // 需求 15：工具箱刚放出来的那几块，2 秒内挂「新」角标并把气泡借过去。
  const [tutRelease, setTutRelease] = useState<readonly ReleasedBlock[]>(NO_RELEASE);
  // 批次 3：功法谱发现记录。algoFound 从 localStorage 初始化，algoCards 是待展示的卡片队列。
  const [algoFound, setAlgoFound] = useState<readonly PatternId[]>([]);
  const [algoCards, setAlgoCards] = useState<readonly PatternId[]>([]);
  // 批次 5：境界解锁的块提示队列。每条 toast 显示 3 秒后自动消失，不叠加。
  const [unlockToasts, setUnlockToasts] = useState<readonly string[]>([]);
  const unlockToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 境界解锁的「新」角标：和 tutRelease 分开，避免挂 .tut class 导致界面变暗。
  const [unlockNewIds, setUnlockNewIds] = useState<readonly string[]>([]);
  const unlockNewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 走火入魔的整屏红闪：0.6 秒一次，不遮操作（pointer-events:none）。
  const [backlashFlash, setBacklashFlash] = useState(false);
  const backlashFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 批次 6：应用内确认弹窗（替代 window.confirm）。null = 没有弹窗。
  const [modal, setModal] = useState<ModalRequest | null>(null);
  // 渡劫浮层（批次 1）。两块都不属于 HudModel：面板要盖住 HUD 与画布，结果层要盖住整屏。
  // demoTrial = 「演示模式下按 X 打开的面板」：演示里点 HUD「可冲关」仍当场结算（任务 9 的裁定没动），
  // runtime 在 demoMode 下压根不落 trialUntil，所以这块面板只能由 UI 自己举着。
  const [demoTrial, setDemoTrial] = useState(false);
  // 最近一次结算的展示数据（含 1.2s + 1.5s 的停留窗口）；null = 结果层不在屏上。
  const [outcome, setOutcome] = useState<ChallengeOutcome | null>(null);
  // 结果层出现的一刻：点击跳过的 1.5 秒闸按它判（口径见 RESULT_HOLD_MS）。
  const outcomeSinceRef = useRef(0);
  const outcomeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 面板里两个按钮的实现在 useEffect 里才拿得到 runtime，这里同样只留转发口。
  const trialPressRef = useRef<((mode: 'manual' | 'auto' | 'parry') => void) | null>(null);
  // 调试跳关（F 键）后立刻清 HUD 闸门，不等下一帧自然刷新。
  const clearHudKeyRef = useRef<(() => void) | null>(null);

  const handleDismissAlgoCard = (): void => {
    setAlgoCards((previous) => previous.slice(1));
  };

  // 批次 5：moment 队列（解锁 / 走火 / 杂念 / 试炼 / 首次 stall）共用一条 toast 通道。
  // 时长与 showToast 用同一个 TOAST_MS：之前队列自己写 3 秒、showToast 写 6 秒，
  // 两条定时器会互相覆盖（实测 toast 停在屏上 5.6 秒才消失），这里是唯一的口径。
  // 时序：等结果层（outcome）消失后 300ms 再开始播放，避免被结果层盖住。
  const UNLOCK_DELAY_AFTER_OUTCOME = 300;
  useEffect(() => {
    if (unlockToasts.length === 0) {
      if (unlockToastTimerRef.current !== null) {
        clearTimeout(unlockToastTimerRef.current);
        unlockToastTimerRef.current = null;
      }
      return;
    }
    // 结果层在场时只排队，不播放
    if (outcome !== null) {
      return;
    }
    // 结果层消失后等 300ms 再开始播放
    const delayTimer = setTimeout(() => {
      const first = unlockToasts[0];
      if (first === undefined) return;
      // 内联 toast 逻辑：showToast 在另一个 useEffect 里，这里直接 setHud。
      setHud((previous) => ({ ...previous, toast: momentToastText(first) }));
      if (unlockToastTimerRef.current !== null) clearTimeout(unlockToastTimerRef.current);
      unlockToastTimerRef.current = setTimeout(() => {
        setHud((previous) => ({ ...previous, toast: null }));
        setUnlockToasts((previous) => previous.slice(1));
      }, TOAST_MS);
    }, UNLOCK_DELAY_AFTER_OUTCOME);
    return () => {
      clearTimeout(delayTimer);
      if (unlockToastTimerRef.current !== null) clearTimeout(unlockToastTimerRef.current);
    };
  }, [unlockToasts, outcome]);

  useEffect(() => {
    const container = containerRef.current;
    const runtime = runtimeRef.current;
    if (container === null || runtime === null) return;

    const storage = createLocalStorageSaveStorage();
    const demoFlags = createSessionFlagStore();
    // 试炼最佳效率是元进度：按活动槽读一次，之后由达成时更新（写回同一个键）。
    const loadedBest = readBest(storage);
    bestMapRef.current = loadedBest;
    setBestMap(loadedBest);

    // R 键的清档走「写标记 + reload」，真正的删除发生在这里 —— 读存档之前。
    // 晚一步就不干净：runtime 一旦把旧档读进内存，收尾的 controller.flush() 会原样写回去。
    if (consumeDemoReset(demoFlags)) {
      console.warn(`[演示重置] 已清掉 ${clearGongfaKeys(storage)} 个存档键`);
    }

    // ---- 任务 8 P0-C / P0-D：引导 ----
    // 声明在 inject 之前：工具箱要不要藏块、flyout 上挂哪些 class，都由这几个量决定；
    // 而「是不是第一次进游戏」要等 loadBlocks 之后才判得出来，所以这里先占位、稍后激活。
    // 进度本身是内存态（和 attempt / insight 同一类）：只有「永久关闭」写 localStorage。
    let tutActive = false;
    let tutStep: TutorialStep = 1;
    let tutReleased = true;
    let tutBreathDragged = false;
    let tutPressed = false;
  // 批次 15：这一步有没有被玩家点「继续」。翻页由它驱动。
  let tutClicked = false;
  // 批次 16：被动入魔只播一次。
  let daoFallbackSeen = false;
  // 批次 25：试炼「优秀」给本境免罚，换境界就失效。
  let trialMercyRealm = -1;
    let tutStepAt = 0;
    // 需求 13：已经由「气泡上屏」起过表的那一步。每步只认第一次报告，重复报告会把计时一推再推。
    let tutArmedFor: TutorialPlayStep | null = null;
    let tutBar: TutorialBarModel | null = null;
    let tutBarSig = '';
    let tutReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    let tutEndTimer: ReturnType<typeof setTimeout> | null = null;
  // 批次 18：Blockly 尺寸观察器的清理句柄（窄屏重排后必须重新量一次 SVG）。
  let cleanupResizeObserver: (() => void) | null = null;
    // 需求 15：释放窗口（2 秒）里刚放出来的块 id。空 = 不在窗口内。
    let tutNewIds: readonly string[] = [];
    let tutBadgeTimer: ReturnType<typeof setTimeout> | null = null;

    // 工具箱按境界门控（契约 §4.3 的解锁列）：炼气只给 4 块，筑基起补「如果 / 循环」。
    // ?demo=1 全开（01-design §11.4「演示模式强制全开」）。Blockly 的 updateToolbox 重建整棵 flyout，
    // 但 flyout 是「打开时才渲染」的，所以只换 ToolboxJson 不会碰画布上已有的积木，也不触发 compile。
    // 引导的临时藏块（hidden）叠在同一份 ToolboxJson 上、走同一个入口，才不会出现两份工具箱口径。
    const workspace = Blockly.inject(container, {
      // 积木皮肤：thrasos 上改圆角/凹槽（见 blockSkin.ts）；删掉这行就回默认外观。
      renderer: RENDERER_NAME,
      theme: Blockly.Theme.defineTheme(GONGFA_THEME.name, GONGFA_THEME as unknown as ThemeConfig),
      toolbox: toolboxForRealm(booted.realmIndex, booted.demo) as unknown as NonNullable<InjectOptions['toolbox']>,
      // 批次 19：手机上一块积木按 1.0 画出来有半个屏大，工具箱直接溢出。
      // 窄屏统一 0.72 起步，桌面保持 1.0。
      zoom: { startScale: window.innerWidth < 900 ? 0.72 : 1, minScale: 0.4, maxScale: 1.6, controls: true, wheel: true, pinch: true },
    });

    // 批次 18：手机/窄屏下 Blockly 的 SVG 尺寸是在 inject 时定的，布局换成堆叠后
    // 只要不 resize，工具箱里的积木就会画在可视区之外（真机实测左侧一整片空白灰）。
    // 三种时机都要补：立刻、字体加载后、窗口尺寸/方向变化。
    const resizeCanvas = (): void => {
      try {
        Blockly.svgResize(workspace);
      } catch {
        // Blockly 在卸载过程中会抛「workspace disposed」，忽略即可
      }
    };
    resizeCanvas();
    // 窄屏：存档里的画布坐标来自桌面，手机上「每 tick」会落在右边缘外。
    // 只居中，不 zoomToFit —— 后者会把积木放大到塞满，反而更难拖。
    if (window.innerWidth < 900) {
      const hat = workspace.getBlocksByType('tick_hat', false)[0];
      if (hat !== undefined) workspace.centerOnBlock(hat.id);
    }
    const resizeLater = window.setTimeout(() => {
      resizeCanvas();
      // 手机：Blockly 恢复视口要晚于首帧，600ms 再居中一次，否则「每 tick」贴在最右边。
      if (window.innerWidth < 900) {
        const hat = workspace.getBlocksByType('tick_hat', false)[0];
        if (hat !== undefined) workspace.centerOnBlock(hat.id);
      }
    }, 600);
    addBlockRef.current = (type: string): void => {
      const block = workspace.newBlock(type);
      block.initSvg();
      block.render();
      // 手机上画布小，让新块自动落位比手动拖更省事：
      // BODY 空 → 接 BODY；BODY 已占 → 沿 BODY 链走到链尾、接 next；都不行才浮空。
      // （原来只有「BODY 空才接」，第 2 块起全浮空 —— 玩家点第二下看不到任何变化。）
      const hat = workspace.getBlocksByType('tick_hat', false)[0];
      const body = hat?.getInput('BODY')?.connection ?? null;
      let tail = body?.targetBlock() ?? null;
      while (tail !== null) {
        const next = tail.nextConnection?.targetBlock() ?? null;
        if (next === null) break;
        tail = next;
      }
      const tailNext = tail?.nextConnection ?? null;
      const placement = palettePlacement({
        statement: block.previousConnection !== null,
        bodyConnected: body?.isConnected() === true,
        tailHasNext: tailNext !== null && tailNext.targetBlock() === null,
      });
      if (placement === 'body' && body !== null && block.previousConnection !== null) {
        body.connect(block.previousConnection);
      } else if (placement === 'chain' && tailNext !== null && block.previousConnection !== null) {
        tailNext.connect(block.previousConnection);
      } else {
        block.moveBy(80, 120);
      }
      block.select();
      workspace.centerOnBlock(block.id);
    };

    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', resizeCanvas);
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(resizeCanvas);
      observer.observe(container);
      cleanupResizeObserver = () => observer.disconnect();
    }

    // flyout 的块是渲染过的积木，getSvgRoot 在 BlockSvg 上；类型入口没导出 BlockSvg，这里按形状取。
    type RenderedBlock = { readonly getSvgRoot: () => SVGGElement };
    const TUT_TYPES = ['breath', 'calm', 'gongfa_compare'] as const;
    const refreshFlyoutClasses = (): void => {
      const inner = workspace.getFlyout()?.getWorkspace();
      if (inner === undefined || inner === null) return;
      const focus = tutActive ? flyoutFocusType(tutStep) : null;
      // 呼吸高亮只在第 1 步、且第一块吐纳还没落地之前（P0-C 第 2 项）。
      const breathe = tutActive && tutStep === 1 && !tutBreathDragged;
      for (const type of TUT_TYPES) {
        for (const block of inner.getBlocksByType(type, false)) {
          const svg = (block as unknown as RenderedBlock).getSvgRoot();
          // 需求 15：窗口内的新块和这一步聚焦的那块一样全亮 ——
          // .tut 那条 :not(.tut-focus) 会把刚放出来的积木压成 0.6，那正好是「看这里」的反面。
          svg.classList.toggle('tut-focus', type === focus || tutNewIds.includes(type));
          svg.classList.toggle('tut-breath', type === 'breath' && breathe);
        }
      }
    };
    let toolboxSig = `${booted.realmIndex}|`;
    // 批次 5 补完：工具箱全局常驻（不只是引导期）。
    // 理由：这游戏没有「收起工具箱」的需求；误点画布丢工具箱是纯损失。
    // setAutoClose 不在 IFlyout 接口上（在 Flyout 实现里），按形状取，和上面 RenderedBlock 同一手法。
    type FlyoutAutoClose = { readonly setAutoClose: (value: boolean) => void };
    const pinFlyout = (): void => {
      (workspace.getFlyout() as unknown as FlyoutAutoClose | null)?.setAutoClose(false);
    };
    // 批次 5 补完：注入后立即钉住工具箱。
    pinFlyout();
    const applyToolbox = (index: number): void => {
      const hidden = hiddenToolboxTypes(tutActive, tutReleased);
      const sig = `${index}|${hidden.join(',')}`;
      if (sig === toolboxSig) return;
      toolboxSig = sig;
      workspace.updateToolbox(toolboxForRealm(index, booted.demo, hidden) as unknown as Parameters<typeof workspace.updateToolbox>[0]);
      // updateToolbox 把整棵 flyout 换成新 DOM：高亮 class 只能重建后重新挂，缓存 svgRoot 会挂在已废弃的元素上。
      // 同一次重建也可能换掉 flyout 对象本身，钉住要跟着重下一次；气泡侧靠 tutRev 立刻重算。
      pinFlyout();
      refreshFlyoutClasses();
      setTutRev((previous) => previous + 1);
    };

    // 存档里的 workspace 是真相源（契约 §5.1），IR 只是缓存：这里只往 saved 里存 Blockly 的原样 JSON，
    // 每次落盘都从它取，读档时也用它重编译。cache 是最近一次编译产物，落盘时写进 programs 字段。
    let saved: WorkspaceJson | null = null;
    let cache: Program[] = [];

    const loadBlocks = (candidate: unknown): string[] => {
      const apply = (state: unknown): void => {
        const previous = Blockly.Events.getGroup();
        Blockly.Events.setGroup(PROGRAMMATIC_GROUP);
        try {
          workspace.clear();
          Blockly.serialization.workspaces.load(state as SerializedState, workspace);
        } finally {
          Blockly.Events.setGroup(previous);
        }
      };
      // Blockly 拿到形状不对的 JSON 不抛错（字符串就当没东西要装），画布会静默变空。
      // 所以先自己挡一道：不是对象就退回开局程序，让玩家看得见该往哪儿搭。
      // {} 是合法值——Blockly 对空工作区就 save() 出 {}，玩家清空后刷新不该又冒出一个入口块。
      if (candidate !== undefined && candidate !== null && (typeof candidate !== 'object' || Array.isArray(candidate))) {
        apply(STARTER_WORKSPACE_JSON);
        return [`存档里的积木加载失败：workspace 需要对象，收到 ${Array.isArray(candidate) ? '数组' : typeof candidate}，已退回开局程序`];
      }
      try {
        apply(candidate ?? STARTER_WORKSPACE_JSON);
        return [];
      } catch (error) {
        // 改坏的积木结构交给 Blockly 自己判定：退回开局程序，玩家还能接着搭
        apply(STARTER_WORKSPACE_JSON);
        return [`存档里的积木加载失败：${(error as Error).message}，已退回开局程序`];
      }
    };

    const snapshot = (): SaveSnapshot => {
      const state = runtime.state();
      return {
        workspace: saved ?? STARTER_WORKSPACE_JSON,
        programs: cache,
        qi: state.qi,
        demon: state.demon,
        realm: state.realm,
        budgetPool: state.budgetPool,
        totalQi: state.totalQi,
        breakthroughs: state.breakthroughs,
        playMs: state.playMs,
        // 契约 §5.1 的 seed 是回放口径：落盘的必须是这一局真正在用的那一个，不能由基线另带
        seed: state.seed,
        // 任务 6.5：蓄势时刻（§5.1 的 chargeReadyAt）也在运行时字段里，快照不带它就永远写不进档
        chargeReadyAt: state.chargeReadyAt,
        // 任务 5B：持有与装备随时会被四个按钮改写，必须跟着快照走，不能只靠基线带
        ownedBooks: game.ownedBooks,
        equippedBook: game.equippedBook,
        // 任务 7A：道具同理。budgetPool 虽然也落盘（§5.1 面值），但读回来不采信 —— 真池由 attachArtifacts 现算。
        ownedArtifacts: game.ownedArtifacts,
        equippedArtifacts: game.equippedArtifacts,
      };
    };

    // 契约 §5.2 的固定顺序全在 core 的 loadGame 里：envelope → 只取版本号 → 连续迁移 → 校验 → 重编译 → 装载。
    // core 不依赖 Blockly，所以「重编译」这一步由宿主注入编译器。
    const loaded = loadGame({
      storage,
      clock: wallClock,
      compile: (candidate) => compileWorkspace(candidate as WorkspaceJson),
      install: (program) => runtime.load(program),
    });
    const blockErrors = loadBlocks(loaded.state?.workspace);
    const restoreErrors = loaded.state === null ? [] : runtime.restore(loaded.state);

    // 引导激活（P0-C 第 1 项 + P0-D）：判据只剩「没永久关闭」与「不在演示模式」——
    // 有没有存档、玩到第几步都不拦，刷新后由 resumeTutorialStep 从眼前的画布与存量接着走。
    // （旧判据里的「无存档 + 开局 5 秒内 + 画布没动作块」就是真机 BUG 的根因：落过一次盘就再也不启动。）
    // 藏块要立刻生效，所以紧跟一次 applyToolbox：inject 那份是没藏的版本，重建一次才只留「吐纳」。
    const tutState = runtime.state();
    const tutDoneAtBoot = readTutorialDone(storage);
    // 老玩家保护：playMs（§5.1 只算在线，离线不进来）超过 15 分钟还没走完引导的人，
    // 每次刷新都被打断也本来不会再回来看 —— 当场按已完成处理，写 done 之后不再启动。
    if (!tutDoneAtBoot && tutState.playMs > TUTORIAL_PLAY_MS_MAX) writeTutorialDone(storage);
    tutActive = tutorialActiveAt({ done: tutDoneAtBoot, demo: tutState.demo, playMs: tutState.playMs });
    if (tutActive) {
      const breathAtBoot = workspace.getBlocksByType('breath', false).length;
      tutStep = resumeTutorialStep({
        breath: breathAtBoot,
        qi: tutState.qi,
        demon: tutState.demon,
        canBreakthrough: tutState.canBreakthrough,
      });
      // 画布上已经有吐纳 = 第 1 步早完成了：呼吸高亮该停。
      // 放不藏两块：推导出的步骤已经 ≥ 3（批准过的边界），或画布上有吐纳（第 1 步的 3 秒计时器
      // 只在「刚拖上第一块」那一次排程，刷新回来的老玩家等不到它，就会永远少「调息 / 比较」两块）。
      tutBreathDragged = breathAtBoot >= 1;
      tutReleased = breathAtBoot >= 1 || tutStep >= 3;
      // 需求 13：这里只是兜底钟（气泡贴不上、报告丢了时引导仍要能走）；真正起表等 onStepPainted 报回第 1 步。
      tutStepAt = wallClock.now();
      applyToolbox(tutState.realmIndex);
      // 聚焦描边按推导出来的这一步给：不补这一下，刷新回来的人看到的是第 1 步在闪。
      refreshFlyoutClasses();
    }
    // 损坏提示分层：HUD 那一行 + 控制台明细 + 「详情」展开区，都由这一次装载的结果决定
    const corrupted = corruptReport(storage, loaded) ?? pendingCorrupt;
    // 回退备用槽：core 已经把话说好了（「主存档（A 槽）不可用，已回退 B 槽继续」），
    // 这里只负责不让它在 StrictMode 第二次挂载时消失，并把它抬到首屏（不是只躺在面板里）。
    let fallbackNotice: string | null = null;
    if (loaded.state !== null && loaded.fellBack && loaded.summary !== null) {
      fallbackNotice = loaded.summary;
      pendingFallbackNotice = loaded.summary;
    } else if (loaded.state !== null && pendingFallbackNotice !== null) {
      fallbackNotice = pendingFallbackNotice;
      pendingFallbackNotice = null;
    }
    // 红字 = 这一 tick 有东西没按预期跑起来；任何一条都不静默。两处不进红字：
    // ① 积木没能上屏（已退回开局程序）时，core 对存档那份坏 workspace 的编译报错要丢掉——
    //    它说的不是眼前跑的程序，而且开局程序自带入口块，再报「缺少每 tick 入口块」就是假报错；
    // ② 存档损坏：HUD 只留 corrupted 那一行，逐字段明细由 corruptReport 打进 console.group('save:corrupt')。
    // 回退备用槽成功时 loaded.errors 本来就是空（core 只在读不到可用档时才填明细），灰字 notice 说一句即可。
    const archiveErrors = blockErrors.length > 0 || corrupted !== null ? [] : loaded.errors;
    const hardErrors = [...BOOK_CATALOGUE.errors, ...ARTIFACT_CATALOGUE.errors, ...blockErrors, ...restoreErrors, ...archiveErrors];
    // 装备与持有是 GameState 的字段，也是玩家随时会改的东西，所以前台拿一份可变的档面走：
    // 装载/卸下/固化改写它，落盘由 snapshot 带出去，读写两端各校验一次（契约 §5.2）。
    // 新档直接带开局书（D3）；5A 落盘的旧档里 ownedBooks 是空的，靠 grantStarterBook 当场补发一次。
    let game: GameState = loaded.state ?? newGameState({ seed: runtime.state().seed, workspace: saved ?? STARTER_WORKSPACE_JSON, now: wallClock.now(), ownedBooks: [STARTER_BOOK_ID] });
    const grant = grantStarterBook(game, BOOK_CATALOGUE);
    game = grant.state;
    // 保底跨刷新（2026-11-26）：契约 §7.1 的「连续 3 次」不能因为刷新就清零。
    // 只恢复同一境界的记录；换境/成功/清档时 attempt=1，会在下面的帧同步里清掉。
    const storedPity = readPity(storage);
    if (storedPity !== null && storedPity.realm === runtime.state().realm) {
      runtime.restoreAttempt(storedPity.attempt);
    }
    let algoFoundState: readonly PatternId[] = readFound(storage);
    setAlgoFound(algoFoundState);
    let noticeList: readonly string[] = [
      ...loaded.notices,
      // StrictMode 第二次挂载时 loaded.notices 已经是空的了（指针已切到好槽），靠兜底变量补回面板那一行。
      ...(fallbackNotice !== null && !loaded.notices.includes(fallbackNotice) ? [fallbackNotice] : []),
      ...(grant.notice === null ? [] : [grant.notice]),
    ];
    // 按钮点出来的错误（非法相位、目录查不到书、积木装不上）单独一路：compile() 每次都重算 playErrors，
    // 不并进来就会被下一次改动抹掉。
    let actionErrors: string[] = [];
    // 红字分两路：playErrors = 程序/存档本身没跑起来，saveErrors = 落盘失败（超限、配额满）。
    // 落盘失败必须显眼：玩家以为存上了、其实没存，比编译报错更能坑人。
    let playErrors: string[] = [...hardErrors];
    let saveErrors: string[] = [];
    const controller = createSaveController({
      storage,
      clock: wallClock,
      base: game,
      getSnapshot: snapshot,
      onStatus: (status) => {
        saveErrors = [...status.messages];
        setHud((previous) => ({
          ...previous,
          errors: [...playErrors, ...saveErrors],
          save: status.savedAt === null ? previous.save : [`存档 ${clockText(status.savedAt)}`],
        }));
      },
    });
    saveRef.current = controller;
    const detachSave = controller.attach();

    // ---- 任务 5B：功法书 ----
    let bookPhase: BookPhase = 'IDLE';

    const pushActionErrors = (messages: readonly string[]): void => {
      if (messages.length === 0) return;
      actionErrors = [...new Set([...actionErrors, ...messages])];
      setHud((previous) => ({ ...previous, errors: [...new Set([...previous.errors, ...messages])] }));
    };

    const pushNotice = (message: string): void => {
      noticeList = [...new Set([...noticeList, message])];
      setHud((previous) => ({ ...previous, notices: noticeList }));
    };

    // 装备位 → 书：loadBook 交回的是深拷贝，目录本体永远是原始真相（DIRTY 判定要跟它比）。
    // 表里查不到这个 id 就报红字并按无书结算，不假装还装着。
    const equippedBook = (): { readonly book: BookDef | null; readonly errors: readonly string[] } => bookById(BOOK_CATALOGUE, game.equippedBook);

    // userEdit：这一轮刷新由玩家改动触发（程序化换画布、装载后的首次刷新都不算），
    // 只有玩家改动才拿 bookEvent('edit') 跟画布推导的相位对账。
    const refreshBook = (userEdit: boolean): void => {
      const current = equippedBook();
      const derived = derivePhase({
        equippedBook: game.equippedBook,
        workspace: saved ?? STARTER_WORKSPACE_JSON,
        bookWorkspace: current.book?.workspace ?? null,
        starterWorkspace: STARTER_WORKSPACE_JSON,
      });
      if (userEdit && game.equippedBook !== null) {
        // 相位以画布推导为准（D1：dirty 不落库、每次当场推导），状态机在这里只当一道越界检查：
        // 它拒绝这次编辑（说明我们记的相位和画布对不上）才报红字。
        // 不做「机器给的相位 vs 推导的相位」逐次等值比较：拖一下积木位置只会发 MOVE，
        // 结构没变 → 机器判 DIRTY、画布推导 LOADED，那是正常现象，不是故障，报出来就是假红字。
        const step = bookEvent(bookPhase, { t: 'edit' }, true);
        if (step.errors.length > 0) pushActionErrors(step.errors);
      }
      bookPhase = derived;
      // 成对装卸（契约 §4）：只有 LOADED / DIRTY 才带着书的衰减与 modifiers 去结算，
      // 其余相位（含「装备位有 id 但表里查不到」）一律 null，等于把两条乘数一起清零。
      runtime.attachBook(derived === 'LOADED' || derived === 'DIRTY' ? current.book : null);
      const numbers = runtime.state();
      const title = current.book?.name.zh ?? STARTER_BOOK_ID;
      const head = derived === 'IDLE' ? '未装载功法' : derived === 'FROZEN' ? '个人功法（已固化）' : `《${title}》 衰减 ${numbers.bookDecay.toFixed(3)}`;
      // 心魔乘数印在这里：卸下或固化之后必须看到 ×1.00，乘数是不是真被移除当场可查
      const text = `${head} · 心魔 ×${numbers.demonMult.toFixed(2)}`;
      pushActionErrors(current.errors);
      setHud((previous) => ({ ...previous, book: { phase: derived, text, loadable: BOOK_CATALOGUE.books.length } }));
    };

    const reloadCanvas = (candidate: unknown): void => {
      pushActionErrors(loadBlocks(candidate));
    };

    const runBookEvent = (event: BookEvent): void => {
      const equipped = event.t === 'load' ? BOOK_CATALOGUE.books.length > 0 : game.equippedBook !== null;
      const step = bookEvent(bookPhase, event, equipped);
      if (step.errors.length > 0) {
        pushActionErrors(step.errors);
        return;
      }
      if (event.t === 'load') {
        const target = bookById(BOOK_CATALOGUE, STARTER_BOOK_ID);
        // 真正的装载动作：FROZEN 分支要等弹窗确认后才执行，所以抽成闭包。
        const applyLoad = (): void => {
          // 防御性校验：书本身带 realm，模板里的积木也必须是当前境界能给的。
          // 现在只有一本炼气书，这条不会触发；加高阶书时它就是闸门。
          const realmIndexNow = runtime.state().realmIndex;
          const availableNow = toolboxForRealm(realmIndexNow, runtime.state().demo).contents.map((entry) => entry.type);
          const missingNow = target.book === null ? [] : missingBlocksIn(target.book.workspace, availableNow);
          if (target.book !== null && (target.book.realm > realmIndexNow || missingNow.length > 0)) {
            showToast(`这本功法要 ${target.book.realm === 0 ? '炼气' : target.book.realm === 1 ? '筑基' : target.book.realm === 2 ? '金丹' : '元婴'}才能运转`);
            return;
          }
          if (target.book === null) {
            pushActionErrors(target.errors);
            return;
          }
          game = { ...game, equippedBook: target.book.id, ownedBooks: [...new Set([...game.ownedBooks, target.book.id])] };
          reloadCanvas(target.book.workspace);
          pushNotice(`已用《${target.book.name.zh}》覆盖当前程序`);
        };
        // O2：IDLE / LOADED / DIRTY 直接覆盖 + 灰字；FROZEN 的个人程序不在任何一本书里，覆盖前先问一句
        if (bookPhase === 'FROZEN') {
          setModal({
            title: '覆盖已固化的个人功法？',
            body: '装载功法书会覆盖你当前固化的个人功法，且无法恢复。',
            confirmText: '覆盖',
            danger: true,
            onConfirm: applyLoad,
          });
          return;
        }
        applyLoad();
        return;
      }
      if (event.t === 'discard') {
        const target = equippedBook();
        if (target.book === null) {
          pushActionErrors(target.errors);
          return;
        }
        reloadCanvas(target.book.workspace);
        pushNotice('已放弃修改，画布回到书原文');
        return;
      }
      if (event.t === 'freeze') {
        // 固化 = 保留画布、卸下书（D1）：equippedBook 置空，衰减与 modifiers 成对移除，FROZEN 按无书结算
        game = { ...game, equippedBook: null };
        refreshBook(false);
        pushNotice('已固化为个人功法：书的衰减与心魔修正同时移除');
        controller.markDirty();
        return;
      }
      // unload：画布回开局程序（reload starter 会触发 compile → refreshBook，不用手动同步）
      game = { ...game, equippedBook: null };
      reloadCanvas(STARTER_WORKSPACE_JSON);
      pushNotice('已卸下功法');
    };

    // HUD 的四个按钮就是四个事件：名字一一对应，转成 {t} 交给状态机
    bookActionRef.current = (action: BookAction) => {
      runBookEvent({ t: action });
    };
    const detachBook = (): void => {
      bookActionRef.current = null;
    };

    // ---- 任务 7A：道具（玉简 + 算盘）----
    // 装备位是唯一真相：sink 里的玉简规格与 VM 的预算池都由它当场现算，所以读档后、每次开关后都重跑一遍。
    // 这里不采信 state.budgetPool 那个面值（决策 2：改档不能凭空扩池 —— 把 250 写进档再读回来就白得 50 步）。
    const syncArtifacts = (): void => {
      const equipment = equipmentFor(ARTIFACT_CATALOGUE, game.equippedArtifacts);
      runtime.attachArtifacts(equipment);
      pushActionErrors(equipment.errors);
      setHud((previous) => ({ ...previous, artifacts: artifactRows(game.equippedArtifacts, artifactRealm, game.ownedArtifacts) }));
    };
    syncArtifacts();

    // ---- 批次 22：道具获得 ----
    // 新手赠一件，其余靠渡劫掉落。掉落只改 owned，不自动装备：
    // 「要不要装」是玩家的决定，而「拿到了」需要一个能被看见的瞬间。
    let lastRealmSeen = game.realm;
    const grantArtifacts = (ids: readonly string[], reason: string): void => {
      const fresh = ids.filter((id) => !game.ownedArtifacts.includes(id));
      if (fresh.length === 0) return;
      game = { ...game, ownedArtifacts: [...game.ownedArtifacts, ...fresh] };
      syncArtifacts();
      controller.markDirty();
      const names = fresh
        .map((id) => ARTIFACT_CATALOGUE.artifacts.find((artifact) => artifact.id === id)?.name.zh ?? id)
        .join('、');
      // 引导期间不弹：它会正好压在气泡落点上（第 4 步实测被"入门赠礼"盖住）。
      // 道具照常入袋，只是晚一点再介绍它。
      if (!tutActive) {
        setHud((previous) => ({ ...previous, toast: `${reason}：《${names}》已入储物袋，点「装备」生效` }));
      }
      for (const id of fresh) {
        const moment = `art-${id === 'jade' ? 'jade' : id}` as MomentId;
        if ((MOMENT_TEXTS as Readonly<Record<string, string>>)[moment] !== undefined) pushMoment(moment);
      }
    };

    // 批次 31：境界以 runtime 为准。
    // 原来用 game.realm（只在落盘时更新），演示跳关/离线突破后会显示旧境界，
    // 于是「灵珠 · 筑基解锁」这种文案在金丹还挂着 —— 验收时抓到的真 bug。
    let artifactRealm = game.realm;

    let artifactNotice: string | null = null;
    // 换道具的灰字只留最新一条：pushNotice 是去重累加的，来回开关会攒出一串同义的提示。
    const setArtifactNotice = (message: string): void => {
      noticeList = [...noticeList.filter((line) => line !== artifactNotice), message];
      artifactNotice = message;
      setHud((previous) => ({ ...previous, notices: noticeList }));
    };

    // 「装备即拥有」（决策 1）：P0 没有解锁来源，点亮一件才补 owned，
    // 否则 equipped ⊄ owned，下一次落盘会被 §5.1 的校验整份打回。卸下只清装备位、保留持有。
    artifactActionRef.current = (id: string): void => {
      const name = ARTIFACT_CATALOGUE.artifacts.find((artifact) => artifact.id === id)?.name.zh ?? id;
      const wearing = !game.equippedArtifacts.includes(id);
      game = {
        ...game,
        ownedArtifacts: wearing ? [...new Set([...game.ownedArtifacts, id])] : game.ownedArtifacts,
        equippedArtifacts: wearing ? [...game.equippedArtifacts, id] : game.equippedArtifacts.filter((worn) => worn !== id),
      };
      syncArtifacts();
      // 同 §4.4「限时改功法」那条口径：装备改的是接下来每个 tick 的步数与产出，已经攒下的数字不动。
      setArtifactNotice(`《${name}》${wearing ? '已装备' : '已卸下'}：只改接下来的产出与预算，不改已攒下的数字`);
      controller.markDirty();
      // 批次 3：装备变了就重新识别（cache 图案依赖玉简装备）。
      recognizePatterns();
    };
    const detachArtifacts = (): void => {
      artifactActionRef.current = null;
    };

    // ---- 批次 28：藏经阁 ----
    // 悟道是元进度，来源见 insightSources：首次发现图案 +1、本境试炼达成 +1、渡劫失败 +1。
    // 账本 `gongfa:insight:awarded` 防重复；启动时按「已发现 / 已达成」补发（老玩家不吃亏）。
    let metaInsight = readInsight(storage);
    let awardedSources = readAwarded(storage);
    const bootSources = sourceIds(readFound(storage), Object.keys(loadedBest).map(Number));
    const bootMissing = missingSources(bootSources, awardedSources);
    if (bootMissing.length > 0) {
      const granted = insightFromSources(bootMissing);
      metaInsight += granted;
      awardedSources = [...awardedSources, ...bootMissing];
      writeAwarded(storage, awardedSources);
      writeInsight(storage, metaInsight);
      pendingBackfillNotice = `补发悟道 +${granted}（已发现的图案 / 已达成试炼）`;
      noticeList = [...noticeList, pendingBackfillNotice];
    } else if (pendingBackfillNotice !== null) {
      noticeList = [...noticeList, pendingBackfillNotice];
      pendingBackfillNotice = null;
    }
    let learnedScriptures = readLearned(storage);
    // runtime 的 insight 是本档累计，逐帧只做增量同步（刷新后从 0 起，不会重复加）。
    let insightSynced = 0;
    let scriptureHintShown = false;

    const scriptureRows = (): readonly ScriptureRow[] =>
      SCRIPTURES.map((item) => {
        const realmLocked = runtime.state().realmIndex < item.realm;
        const missing = missingPatterns(item, algoFoundState);
        return {
          id: item.id,
          name: item.name,
          algorithm: item.algorithm,
          teach: item.teach,
          cost: item.cost,
          tier: item.tier ?? 'basic',
          requiresText: missing.map((id) => patternDef(id).name).join('、'),
          learned: learnedScriptures.includes(item.id),
          affordable: metaInsight >= item.cost,
          realmLocked,
          unlockText: realmLocked ? `${item.realmName}解锁` : '',
        };
      });

    const refreshScriptures = (): void => {
      setHud((previous) => ({ ...previous, insight: metaInsight, scriptures: scriptureRows() }));
    };
    refreshScriptures();

    /** 藏经阁标题下那句来源说明：三个来源 + 已拿到的图案/试炼数。 */
    const scriptureSourcesText = (): string => {
      const foundCount = algoFoundState.length;
      const trialCount = Object.keys(bestMapRef.current).length;
      return `悟道来源：首次发现图案 +1（${foundCount}/${PATTERN_TOTAL}）· 本境试炼达成 +1（${trialCount}/4）· 渡劫失败 +1`;
    };

    /** 发一笔来源；账本里已有就返回 0（幂等）。余额写失败下次启动会按账本差集补。 */
    const awardSource = (source: string): number => {
      if (awardedSources.includes(source)) return 0;
      const value = insightValueOf(source);
      if (value <= 0) return 0;
      awardedSources = [...awardedSources, source];
      metaInsight += value;
      writeAwarded(storage, awardedSources);
      writeInsight(storage, metaInsight);
      refreshScriptures();
      return value;
    };

    const formationRows = (): readonly FormationRow[] =>
      FORMATIONS.map((item) => {
        const locked = runtime.state().realmIndex < item.realm;
        return {
          id: item.id,
          name: item.name,
          algorithm: item.algorithm,
          teach: item.teach,
          realmName: item.realmName,
          locked,
          unlockText: locked ? `${item.realmName}解锁` : '',
        };
      });

    learnScriptureRef.current = (id: string): void => {
      const item = scriptureOf(id);
      if (item === null) return;
      if (!canLearn(item, metaInsight, learnedScriptures, runtime.state().realmIndex, algoFoundState)) {
        const missing = missingPatterns(item, algoFoundState);
        const reason = learnedScriptures.includes(id)
          ? '这套已经学过了'
          : runtime.state().realmIndex < item.realm
            ? `这套功法要 ${item.realmName}才能运转`
            : missing.length > 0
              ? `需先领悟：${missing.map((pattern) => patternDef(pattern).name).join('、')}`
              : `悟道不够（需要 ${item.cost}）`;
        showToast(reason);
        return;
      }
      metaInsight -= item.cost;
      learnedScriptures = [...learnedScriptures, id];
      writeInsight(storage, metaInsight);
      writeLearned(storage, learnedScriptures);
      refreshScriptures();
      showToast(`已习得《${item.name}》：${item.algorithm}`);
    };

    loadScriptureRef.current = (id: string): void => {
      const item = scriptureOf(id);
      if (item === null) return;
      if (!learnedScriptures.includes(id)) {
        showToast('还没学过这套功法');
        return;
      }
      // 最后一道闸：模板里的积木必须当前境界就能给（防「炼气抄进循环」这类绕过）。
      const missing = missingBlocks(item, toolboxForRealm(runtime.state().realmIndex, runtime.state().demo).contents.map((entry) => entry.type));
      if (missing.length > 0) {
        showToast(`这套功法要 ${item.realmName}才能运转（缺 ${missing.join('、')}）`);
        return;
      }
      setModal({
        title: `抄录《${item.name}》`,
        body: `会用这套功法覆盖当前画布（当前程序会丢）。\n\n${item.teach}`,
        confirmText: '覆盖并抄录',
        onConfirm: () => {
          // 批次 30：抄录前后各取一次速率，3 秒后报差值 —— 「学功法」要在当场看见收益，
          // 而不是让玩家自己去盯 HUD 数字。3 秒足够跑满 30 个 tick，比 10 秒不磨人。
          const before = runtime.state().rate;
          reloadCanvas(item.workspace() as WorkspaceJson);
          showToast(`已抄录《${item.name}》：${item.algorithm}`);
          window.setTimeout(() => {
            const after = runtime.state().rate;
            if (before <= 0) {
              showToast(`《${item.name}》：现在 ${after.toFixed(1)} / 秒`);
              return;
            }
            const ratio = after / before;
            // 倍数小的时候说百分比（+23% 比 ×1.23 直观），大的时候说倍数
            // （+2134% 这种数字没有意义，×22 才读得懂）。
            const delta = ratio >= 1.5
              ? `×${ratio.toFixed(1)}`
              : `${Math.round((ratio - 1) * 100) >= 0 ? '+' : ''}${Math.round((ratio - 1) * 100)}%`;
            showToast(`抄录前 ${before.toFixed(1)} / 秒 → 现在 ${after.toFixed(1)} / 秒（${delta}）`);
          }, 3000);
        },
      });
    };

    // 阵法阁：拓印 = 在当前功法末尾追加；不替换现有引灵（mergeFormation 的硬约束）。
    traceFormationRef.current = (id: string): void => {
      const item = formationOf(id);
      if (item === null) return;
      if (runtime.state().realmIndex < item.realm) {
        showToast(`《${item.name}》要 ${item.realmName}才能拓印`);
        return;
      }
      const current = Blockly.serialization.workspaces.save(workspace) as unknown as WorkspaceJson;
      const merged = mergeFormation(current, item);
      const available = toolboxForRealm(runtime.state().realmIndex, runtime.state().demo).contents.map((entry) => entry.type);
      const missing = missingBlocksIn(merged.workspace, available);
      if (missing.length > 0) {
        showToast(`这套阵法要 ${item.realmName}才能运转（缺 ${missing.join('、')}）`);
        return;
      }
      setModal({
        title: `拓印《${item.name}》到现有功法`,
        body: `会在现有功法末尾追加 ${merged.appended} 块（保留现有 ${merged.kept} 块）。\n原有引灵 ${merged.arraysBefore} 块原样保留，追加后 ${merged.arraysAfter} 块。\n\n${item.teach}`,
        confirmText: '追加到现有功法',
        onConfirm: () => {
          const before = runtime.state().rate;
          reloadCanvas(merged.workspace as WorkspaceJson);
          showToast(`已拓印《${item.name}》：只追加，未替换现有积木`);
          window.setTimeout(() => {
            const after = runtime.state().rate;
            if (before <= 0) {
              showToast(`《${item.name}》：现在 ${after.toFixed(1)} / 秒`);
              return;
            }
            const ratio = after / before;
            const delta = ratio >= 1.5
              ? `×${ratio.toFixed(1)}`
              : `${Math.round((ratio - 1) * 100) >= 0 ? '+' : ''}${Math.round((ratio - 1) * 100)}%`;
            showToast(`拓印前 ${before.toFixed(1)} / 秒 → 现在 ${after.toFixed(1)} / 秒（${delta}）`);
          }, 3000);
        },
      });
    };

    // HUD 的渲染闸门：逐帧把看得出来的变化量化成 key，key 不变就不重渲染。
    // 声明在这里是因为渡劫回调点完要把它清空 —— 结算改了 chargeReadyAt / attempt / insight，
    // 那三个字段不在 key 里，不清就会等下一次数字变化才刷新按钮。
    let lastHudKey = '';
    // 暴露清除函数给调试快捷键（F 键跳关后立刻清闸门，不等下一帧）。
    clearHudKeyRef.current = () => {
      lastHudKey = '';
    };
    // 上一次播报过的结算（同一份引用 = 同一发），用来把托管结算也只说一次。
    let seenChallenge: ChallengeResult | null = null;
    // 批次 5：渡劫前的境界下标，用来计算新解锁的块。
    let realmIndexBeforeChallenge = runtime.state().realmIndex;

    // 批次 5：moment 队列的生产端。四个"状态变了但玩家看不见"的时刻都在这里入队，
    // 播放端是上面的 unlockToasts effect（等结果层消失后再播，3 秒一条）。
    // 去重规则：只有 PERSISTED_MOMENTS（目前只有 stall）写 gongfa:seen；其余是事件，可反复发生。
    const seenMoments = new Set<string>(readSeenActive(storage));
    const pushMoment = (id: MomentId): void => {
      // 批次 32：引导期间不弹「道具说明」这类卡片 —— 它会正好落在气泡的落点上
      // （第 4 步实测：玉简说明盖住了曲线那句话）。引导结束照常补播。
      if (tutActive) return;
      if (PERSISTED_MOMENTS.includes(id)) {
        if (seenMoments.has(id)) return;
        seenMoments.add(id);
        writeSeen(storage, activeSlot(storage), [...seenMoments]);
      }
      setUnlockToasts((previous) => (previous.includes(id) ? previous : [...previous, id]));
    };
    let prevDemon = runtime.state().demon;
    let prevSprintReached = runtime.state().sprintReached;
    let prevBacklashCount = runtime.state().backlashTicks.length;
    // 冷却：杂念 30 秒、走火 10 秒（走火本身有 5 秒罚站，这条只是兜底）。
    const MOMENT_COOLDOWN_MS: Readonly<Record<'noise' | 'backlash', number>> = { noise: 30_000, backlash: 10_000 };
    let lastMomentAt: Record<'noise' | 'backlash', number> = { noise: -Infinity, backlash: -Infinity };

    // 结算的播报不挂在点击上：托管那一发是 run() 里结算的，没有回调可挂，所以逐帧观察 state.lastChallenge。
    // 境界一变要重推书的衰减（新境按新 realmIndex 算），所以成功路径走一次 refreshBook（同任务 6）。
    const reportChallenge = (result: ChallengeResult): void => {
      if (result.phase === 'refused') {
        pushActionErrors(result.errors);
        return;
      }
      refreshBook(false);
      const dice = `第 ${result.attempt} 次 · ${(result.rate * 100).toFixed(0)}% 档 · 骰 ${result.roll.toFixed(4)}`;
      if (result.ok) {
        pushNotice(`渡劫${result.forced ? `（保底第 ${result.attempt} 次）` : ''}成功：进入${result.realmName}，存量与心魔清零 · ${dice}`);
        // 批次 5：检测新解锁的块并排队提示。
        const newRealmIndex = runtime.state().realmIndex;
        if (newRealmIndex !== realmIndexBeforeChallenge) {
          const oldBlocks = TOOLBOX_JSON.contents
            .filter((item) => (MIN_REALM[item.type] ?? 0) <= realmIndexBeforeChallenge)
            .map((item) => item.type);
          const newBlocks = TOOLBOX_JSON.contents
            .filter((item) => (MIN_REALM[item.type] ?? 0) <= newRealmIndex)
            .map((item) => item.type);
          const unlocked = newBlocks.filter((b) => !oldBlocks.includes(b));
          if (unlocked.length > 0) {
            const slot = activeSlot(storage);
            const known = readUnlocked(storage, slot);
            const fresh = unlocked.filter((b) => !known.includes(b));
            if (fresh.length > 0) {
              writeUnlocked(storage, slot, [...known, ...fresh]);
              // 挂「新」角标（2 秒）
              setUnlockNewIds(fresh);
              if (unlockNewTimerRef.current !== null) clearTimeout(unlockNewTimerRef.current);
              unlockNewTimerRef.current = setTimeout(() => setUnlockNewIds([]), NEW_BADGE_MS);
              // 排队 toast（每条 3 秒，不叠加）
              setUnlockToasts((previous) => {
                const merged = [...previous, ...fresh.filter((id) => !previous.includes(id))];
                return merged;
              });
            }
          }
        }
      } else {
        pushNotice(`渡劫失败：存量 ×${FAILURE_QI_MULT} → ${Math.floor(result.qi)}、心魔归 0、悟道 +1 · ${dice}`);
      }
      // 结果层（批次 1）：灰字那一句太小，冲关这种一次性事件要占满一次视线才算「有反馈」。
      // 面板的收起不挂在这里 —— 正式玩法由 phase 离开 trial 自动收，演示由 trialPress 收，
      // 到点托管结算时玩家可能根本没碰按钮，此时面板本来就该跟着 phase 一起消失。
      if (outcomeTimerRef.current !== null) clearTimeout(outcomeTimerRef.current);
      outcomeSinceRef.current = Date.now();
      setOutcome({ ok: result.ok, fromRealmName: result.fromRealmName, realmName: result.realmName, forced: result.forced, attempt: result.attempt });
      // 1.2 秒符箓展开 + 展开后 1.5 秒停留 = 到点自己淡出；中途点击只走 handleDismissOutcome。
      outcomeTimerRef.current = setTimeout(() => setOutcome(null), RESULT_TALISMAN_MS + RESULT_HOLD_MS);
    };

    // 任务 6.5：「可渡劫」的唯一入口。点击本身只可能带来两种新信息：
    // ① 蓄势就绪 → 开启 10 秒挑战；② 前置条件没满足（惩罚 / 阈值 / 末境 / 冷却 / 蓄势）→ 红字。
    // 当场结算（手动确认、演示模式）与到点结算（托管）都由 reportChallenge 说。
    // 批次 8：服丹。失败原因逐条说清楚（冷却 / 心魔太低 / 存量不足），成功也给一句确认。
    pillActionRef.current = (): void => {
      const result = runtime.takePill();
      if (!result.ok) {
        showToast(result.reason ?? '服丹失败');
        return;
      }
      lastHudKey = '';
      showToast('服丹：心魔 -10%，存量 -5%');
    };

    // P1 纵切：炼器炉。只在"真有可改写段落"时给建议，且把代价（步数↑、心魔↑）一并写进弹窗。
    // 不自动应用：改写是玩家的决定，炼器炉只负责把数摆出来。
    optimizeActionRef.current = (): void => {
      const workspaceJson = saved;
      if (workspaceJson === null) {
        showToast('画布上还没有可以分析的功法');
        return;
      }
      // 炼气没有「循环」：炼器炉若把直列折成循环，就绕过了境界门控。
      const repeatUnlocked = runtime.state().realmIndex >= (MIN_REALM['gongfa_repeat'] ?? 0);
      const suggestion = suggestRewrite(workspaceJson, { allowRepeat: repeatUnlocked });
      if (suggestion === null && !repeatUnlocked) {
        showToast('炼器炉要「循环」才能改写 —— 循环在筑基解锁');
        return;
      }
      if (suggestion === null) {
        showToast('没有可改写的段落：需要 3 块以上连续相同的动作');
        return;
      }
      const beforeProgram = compileWorkspace(workspaceJson).program;
      const afterProgram = compileWorkspace(suggestion.after).program;
      const stepsOf = (program: typeof beforeProgram): number =>
        program === null ? 0 : linearizeProgram(program.code, runtime.state().budgetPool).steps;
      const stepsBefore = stepsOf(beforeProgram);
      const stepsAfter = stepsOf(afterProgram);
      const actionName = suggestion.actionType === 'breath' ? '吐纳' : '调息';
      const demonLine = suggestion.demonFactor === 1
        ? '心魔增速不变（调息不涨心魔）'
        : `心魔增速 ×${suggestion.demonFactor}（循环深度 0 → 1）`;
      setModal({
        title: '炼器炉：发现一处可改写',
        body: [
          `${suggestion.where === '' ? '' : `在「${suggestion.where}」里：`}把连续 ${suggestion.runLength} 块「${actionName}」改成「循环 ${suggestion.runLength} 次」。`,
          `IR 指令：${suggestion.irBefore} → ${suggestion.irAfter}（少 ${suggestion.irBefore - suggestion.irAfter} 条）`,
          `每 tick 步数：${stepsBefore} → ${stepsAfter}（多 ${stepsAfter - stepsBefore} 步）`,
          `产出完全等价；${demonLine}。`,
        ].join('\n'),
        confirmText: '应用改写',
        onConfirm: () => {
          reloadCanvas(suggestion.after);
          showToast(`炼器炉：已把 ${suggestion.runLength} 块「${actionName}」折叠成循环`);
        },
      });
    };

    challengeActionRef.current = (): void => {
      // 引导把它当「这一套他会了」：点过就一直算点过（第 5 步不设单独跳过，裁定 3）。
      tutPressed = true;
      // 批次 5：记录渡劫前的境界，用来计算新解锁的块。
      realmIndexBeforeChallenge = runtime.state().realmIndex;
      const result = runtime.pressChallenge();
      if (result.phase === 'trial') {
        lastHudKey = '';
        pushNotice(`渡劫开始：${TRIAL_WAVES_MS.map((ms) => ms / 1000).join(' / ')} 秒三波雷。承雷命中：心魔 −${Math.round(PARRY_DEMON_RELIEF * 100)}%、成功率 +${Math.round(PARRY_BONUS * 100)}%；漏一波：心魔 +${Math.round(PARRY_MISS_DEMON * 100)}%、成功率 −${Math.round(PARRY_PENALTY * 100)}%。不接按承雷战绩结算（${Math.round(PARRY_RATE_MIN * 100)}–${Math.round(PARRY_RATE_MAX * 100)}%），也可点「交给天意」按 ${Math.round(AUTO_RATE * 100)}%。`);
        return;
      }
      if (result.phase === 'idle') {
        pushActionErrors(result.errors);
        return;
      }
      // 结算已经在 runtime 里改完数字并标过脏；这里只打破 HUD 的渲染闸门，让灰字立刻出现。
      lastHudKey = '';
    };

    // 渡劫面板（批次 1）的两个按钮。演示模式那块面板是 X 键举起来的：runtime 在 demoMode 下不落 trialUntil
    // （点「可冲关」仍当场结算，任务 9 的裁定没动），所以面板的开关只能记在 UI 这一侧。
    // demoPanelOpen 是本地镜像，不给闭包读 React state 的机会 —— 状态要下一帧才看得到，按钮不能等。
    let demoPanelOpen = false;
    const openDemoPanel = (): void => {
      demoPanelOpen = true;
      setDemoTrial(true);
    };
    const closeDemoPanel = (): void => {
      demoPanelOpen = false;
      setDemoTrial(false);
    };
    // 面板里的确认 = 手动 85%，「交给天意」= 托管 60%：档位由这一次点击定，runtime 只认参数。
    trialPressRef.current = (mode: 'manual' | 'auto' | 'parry'): void => {
      closeDemoPanel();
      // 'parry' = 渡劫中的承雷：runtime 里走 parryTrial，不动 results、不结算。
      const result = runtime.pressChallenge(mode === 'parry' ? undefined : mode);
      // 面板举着的这 10 秒里存量可能掉回阈值下（§7.1「渡劫无从开始」）：那句拒绝得说出来，不能静默。
      if (result.phase === 'idle' || result.phase === 'refused') pushActionErrors(result.errors);
      lastHudKey = '';
    };

    // 曲线预览（任务 8 P0-B）：画布一变就重算，玩家不必拿 100 秒去验证一个猜想。
    // 对比行的基线是「上一次预览的模型速率」，不是 state.rate —— 后者含杂念折扣，同一份程序会报出两个「每秒」。
    // 基线还带 realmIndex：渡劫换了乘数表，拿上一境的数字做百分比是说假话。
    let curveBase: { readonly perSec: number; readonly realmIndex: number } | null = null;
    let lastCompare: CurveCompare | null = null;
    let curveRealm = booted.realmIndex;
    let toastShown = false;
    let readyToastShown = false;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    // toast 是单通道：后到的顶掉先到的（两条各只说一次，且不会同时发生 —— 裁定里确认过可接受）。
    const showToast = (message: string): void => {
      setHud((previous) => ({ ...previous, toast: message }));
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setHud((previous) => ({ ...previous, toast: null })), TOAST_MS);
    };
    const syncCurve = (program: Program | null): void => {
      const preview = runtime.preview(program);
      if (preview === null) {
        // 编译不过：曲线撤掉、基线与对比行一起作废，否则改回合法程序时会拿一份没在跑的旧速率做对比。
        curveBase = null;
        lastCompare = null;
        setHud((previous) => ({ ...previous, curve: NO_CURVE }));
        return;
      }
      // base 取局部常量：curveBase 是 let，跨语句的判断 TS 不肯收窄，读一次就安全了。
      // 算「变更」要同时满足三条：有基线、同一境界（乘数表没换）、旧速率非零且真的变了（0 → 10 没有百分比可说）。
      const base = curveBase;
      const changed = base !== null && base.realmIndex === preview.realmIndex && base.perSec > 0 && base.perSec !== preview.perSec;
      if (changed) {
        lastCompare = {
          fromPerSec: base.perSec,
          toPerSec: preview.perSec,
          percent: Math.round((preview.perSec / base.perSec - 1) * 100),
        };
        // 一次性：只在「第一次真的显著涨」那回弹，之后再加积木不重复打扰（验收 6）。
        if (!toastShown && lastCompare.percent >= 30) {
          toastShown = true;
          showToast(`同样的时间，你的产出提高了 ${lastCompare.percent}%`);
        }
      } else if (base === null || base.realmIndex !== preview.realmIndex) {
        // 没有可比基线（开局第一份程序、渡劫换表）：上一行的对比说的已经是别一套乘数，撤掉比留着诚实。
        lastCompare = null;
      }
      // 拖一块积木会连着触发好几次 change（新建、移动、连上凹槽），后几次是同一份程序的重复编译。
      // 所以「速率没变」时保留上一行的对比，不能把它抹掉 —— 否则刚看清的 +80% 会在半秒后自己消失。
      curveBase = { perSec: preview.perSec, realmIndex: preview.realmIndex };
      setHud((previous) => ({ ...previous, curve: curveModel(preview, lastCompare) }));
    };

    // ---- 任务 8 P0-D：引导推进 ----
    // 步骤机在 tutorial.ts 里（纯函数、有单测）；这里只做三件脏活：读画布积木数、挂 flyout 的 class、
    // 管两个计时器。不锁操作是硬要求 —— 这段代码里没有任何 pointer-events / disabled 的改动。
    const tutNumbers = (): TutorialNumbers => {
      const state = runtime.state();
      // perSec 与 compare 都取曲线面板那份：引导复述的数字必须和面板同源，否则验收 c) 就是假通过。
      return {
        perSec: curveBase?.perSec ?? 0,
        compare: lastCompare,
        goalQi: state.sprintGoalQi,
        windowSec: state.sprintWindowMs / 1000,
        demon: state.demon,
        breaths: workspace.getBlocksByType('breath', false).length,
        canChallenge: state.canChallenge,
      };
    };

    // 需求 13 的起表口：气泡把「这一步的 n/6 已经画到屏上」报回来，那一刻才许开始数 3 秒。
    // boot 与翻页那两处仍然先写一份兜底时间：气泡万一贴不上、报告丢了，引导不能永远停在第 1 步，
    // 但报告一旦到达就以报告为准 —— 停留是给眼睛的，状态机不该替眼睛提前起表。
    tutAdvanceRef.current = (): void => {
      if (!tutActive) return;
      tutClicked = true;
    };

    tutPaintedRef.current = (shown: TutorialPlayStep): void => {
      if (!tutActive || shown !== tutStep || tutArmedFor === shown) return;
      tutArmedFor = shown;
      tutStepAt = wallClock.now();
    };

    const syncTutorial = (state: RuntimeState): void => {
      if (!tutActive) return;
      const breath = workspace.getBlocksByType('breath', false).length;
      const calm = workspace.getBlocksByType('calm', false).length;
      if (breath >= 1 && !tutBreathDragged) {
        // 第一块吐纳落地：呼吸高亮停掉，3 秒后放出「调息」「比较」（P0-C 第 1、2 项）。
        tutBreathDragged = true;
        refreshFlyoutClasses();
        if (tutReleaseTimer === null) {
          tutReleaseTimer = setTimeout(() => {
            tutReleaseTimer = null;
            // 放出来的就是「刚才被引导藏掉」的那几块：id 从同一张表来，这里不再列一遍名字。
            tutNewIds = hiddenToolboxTypes(tutActive, false);
            tutReleased = true;
            applyToolbox(runtime.state().realmIndex);
            refreshFlyoutClasses();
            setTutRelease(releasedBlocks(tutNewIds));
            if (tutBadgeTimer !== null) clearTimeout(tutBadgeTimer);
            tutBadgeTimer = setTimeout(() => {
              tutBadgeTimer = null;
              tutNewIds = [];
              refreshFlyoutClasses();
              setTutRelease(NO_RELEASE);
            }, NEW_BADGE_MS);
          }, RELEASE_AFTER_DRAG_MS);
        }
      }
      const next = nextTutorialStep(
        tutStep,
        { breath, calm, qi: state.qi, demon: state.demon, hasCompare: lastCompare !== null, pressedChallenge: tutPressed, clicked: tutClicked },
        wallClock.now() - tutStepAt,
      );
      if (next !== tutStep) {
        tutStep = next;
        // 批次 32：第 4 步指的是下方横条里的曲线，滚动过去它才看得见（否则气泡没处贴）。
        // 批次 35：第 4 步的曲线在面板里，得先开面板；第 5/6 步的心魔条与渡劫按钮在右列，
        // 面板开着会把它们盖住，所以再关掉。一开一关都发生在本步开始前，玩家看不到闪。
        if (next === 4) setPanelOpen(true);
        if (next === 5 || next === 6) setPanelOpen(false);
        // 批次 32：走到第 5 步要让「调息」真的在工具箱里 —— 否则文案叫玩家拖一个
        // 被引导自己藏起来的块。所以 ≥3 步就放块，不再等「拖完 5 秒」。
        if (next !== 'done' && next >= 3 && !tutReleased) {
          tutReleased = true;
          applyToolbox(runtime.state().realmIndex);
          refreshFlyoutClasses();
        }
        tutClicked = false;
        tutStepAt = wallClock.now();
        refreshFlyoutClasses();
        if (next === 'done') {
          // 走完六步和点「跳过引导」是同一个结局：这条引导一辈子只来一遍，下次清档也不再重播。
          writeTutorialDone(storage);
          if (tutEndTimer !== null) clearTimeout(tutEndTimer);
          tutEndTimer = setTimeout(() => {
            tutEndTimer = null;
            tutActive = false;
            tutBar = null;
            tutBarSig = '';
            // 批次 5 补完：引导结束但工具箱继续常驻（全局钉住，不再还给玩家开关）。
            pinFlyout();
            setHud((previous) => ({ ...previous, tutorial: null }));
            // 批次 3：引导结束的当下立刻识别一次（裁定 5）。
            recognizePatterns();
          }, END_DWELL_MS);
        }
      }
      const bar = tutorialBar(tutStep, tutNumbers());
      const sig = `${bar.step}|${bar.text}`;
      if (sig !== tutBarSig) {
        tutBarSig = sig;
        tutBar = bar;
      }
    };

    // 裁定 2：跳过只有底部条右端这一个入口。点了就永久关闭，并当场把藏掉的积木放回工具箱 ——
    // 引导没了却还少两块积木，那是引导的副作用在替玩家做决定。
    tutorialSkipRef.current = (): void => {
      if (!tutActive) return;
      writeTutorialDone(storage);
      tutActive = false;
      tutReleased = true;
      tutBar = null;
      tutBarSig = '';
      if (tutEndTimer !== null) {
        clearTimeout(tutEndTimer);
        tutEndTimer = null;
      }
      // 需求 15：引导没了，「新」角标和借走的气泡一起还回去。
      if (tutBadgeTimer !== null) {
        clearTimeout(tutBadgeTimer);
        tutBadgeTimer = null;
      }
      tutNewIds = [];
      setTutRelease(NO_RELEASE);
      refreshFlyoutClasses();
      applyToolbox(runtime.state().realmIndex);
      setHud((previous) => ({ ...previous, tutorial: null }));
      // 批次 3：跳过引导的当下也立刻识别一次（裁定 5 补充：不能出现「跳过 → 谱永远是 0」的死角）。
      recognizePatterns();
    };

    // 演示快捷键（任务 9）：整段只在 ?demo=1 时挂监听。正式玩家不该有「按键刚好落到 F / R
    // 就没掉整个档」这条路（裁定 2）；R 还额外要 confirm 一次，两个闸门叠在一起才算够。
    const onDemoKey = (event: KeyboardEvent): void => {
      if (!booted.demo || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      // Blockly 的字段编辑器就是 input：在「存量」两个字里打个 f，不能当成按了跳关。
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === 'f' || event.key === 'F') {
        const jumped = runtime.jumpToDemoTarget();
        // 跳关后立刻清 HUD 闸门，强制下一帧重渲染（不等到灵力/速率自然变化）。
        clearHudKeyRef.current?.();
        showToast(jumped === null
          ? '跳关没生效：realms 表里找不到目标境界'
          : `演示跳关 · ${jumped.realmName} · 存量 ${Qi.format(jumped.qi)} / 阈值 ${Qi.format(jumped.threshold)}`);
        return;
      }
      if (event.key === 'x' || event.key === 'X') {
        event.preventDefault();
        // X = 只把渡劫面板举起来，不结算（录屏要的是「面板出现 → 点确认 → 结果层」三段，
        // 观众才看得懂 85% 是玩家按出来的而不是白给）。面板已在时再按 X = 点确认键。
        // 注意这条不影响「点 HUD 可冲关 = 当场按手动 85% 结算」：那条裁定仍然只在鼠标路径上。
        if (demoPanelOpen || runtime.state().challengeActive) {
          trialPressRef.current?.('manual');
          return;
        }
        if (runtime.state().canChallenge) {
          openDemoPanel();
          return;
        }
        // 前置条件没满（惩罚期 / 阈值 / 蓄势 / 冷却）：让按钮那条路把拒绝原因打进红字，X 不另造口径。
        challengeActionRef.current?.();
        return;
      }
      if (event.key !== 'r' && event.key !== 'R') return;
      setModal({
        title: '演示重置',
        body: '清空本机全部修仙存档并回到新档？灵力、境界、心魔、功法书、道具、引导记录都会没。',
        confirmText: '清空并重开',
        danger: true,
        onConfirm: () => {
          requestDemoReset(demoFlags);
          window.location.reload();
        },
      });
    };
    // 面板：Esc 关闭（当前打开时）。放在这里是因为 EventListener 需要稳定引用。
    const onPanelEsc = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPanelOpen(false);
    };
    window.addEventListener('keydown', onDemoKey);
    window.addEventListener('keydown', onPanelEsc);

    // 批次 22：炼器炉提示。只在「程序真的变了」时重算，不逐帧编译。
    let furnaceFor: unknown = null;
    let furnaceHinted = false;
    const refreshFurnace = (workspaceJson: WorkspaceJson | null): void => {
      if (workspaceJson === null || workspaceJson === furnaceFor) return;
      furnaceFor = workspaceJson;
      const ready = suggestRewrite(workspaceJson) !== null;
      setHud((previous) => ({ ...previous, furnaceReady: ready }));
      if (ready && !furnaceHinted) {
        furnaceHinted = true;
        setHud((previous) => ({ ...previous, toast: '炼器炉：这段直列能折叠成循环（在「更多工具」里）' }));
      }
    };

    // event 为空 = 挂载时那一次手动编译；组号是我们的程序化换画布 = 不是玩家编辑。
    const compile = (event?: ChangeEvent): void => {
      const blocks = Blockly.serialization.workspaces.save(workspace) as unknown as WorkspaceJson;
      saved = blocks;
      const result = compileWorkspace(blocks);
      // 画布 0 块 = 玩家主动清空，装载一份只含 HALT 的空程序：数字与粒子当场停下。
      // 「有块但编译失败」才保留 lastGood（不调 load），否则改坏一行就把在跑的程序抹了。
      const loadedProgram = result.program ?? (workspace.getAllBlocks(false).length === 0 ? EMPTY_CANVAS_PROGRAM : null);
      cache = result.program === null ? [] : [result.program];
      // 去重：读档时的编译报错和当前工作区的编译报错常是同一句话，两条一样的红字既吵也会撞 React 的 key
      playErrors = [...new Set([...result.errors, ...hardErrors, ...actionErrors, ...(loadedProgram === null ? [] : runtime.load(loadedProgram))])];
      // 画布内容变了就可能 LOADED ↔ DIRTY（D1：dirty 不落库，每次都重新推导），顺带重算装备的乘数
      refreshBook(event !== undefined && event.group !== PROGRAMMATIC_GROUP);
      setHud((previous) => ({ ...previous, errors: [...playErrors, ...saveErrors] }));
      syncCurve(result.program);
      controller.markDirty();
      // 批次 3：画布变了就重新识别算法图案。
      recognizePatterns();
      // 批次 22：画布变了才重算「有没有可折叠的直列」（炼器炉提示灯）。
      refreshFurnace(blocks);
    };

    workspace.addChangeListener(compile);
    compile();

    // 批次 3：算法识别。引导期间不识别（裁定 5），引导结束或跳过的当下立刻识别一次。
    // 识别结果写入 localStorage（按槽隔离），并触发卡片队列与 HUD 更新。
    function recognizePatterns(): void {
      if (tutActive) return;
      const program = cache[0];
      if (program === undefined) return;
      const shape = shapeOf(program.code, game.equippedArtifacts);
      const hits = patternsOf(shape);
      // 去重源每次从存储读：闭包变量 algoFoundState 会在 effect 重建时变回旧值，
      // 导致同一图案被反复 enqueue。存储是唯一真相（与 writeFound 同源）。
      const known = readFound(storage);
      const fresh = hits.filter((id) => !known.includes(id));
      if (fresh.length === 0) return;
      const next = [...known, ...fresh];
      // 同步闭包变量：主循环 effect 用它渲染 HUD 的功法谱行，不更新的话 HUD 永远显示旧值。
      algoFoundState = next;
      setAlgoFound(next);
      writeFound(storage, next);
      // 2026-11-26：首次发现图案也给悟道 +1（账本去重）。顺利玩家不靠失败也能攒够学费。
      const awardedInsight = fresh.reduce((sum, id) => sum + awardSource(patternSource(id)), 0);
      // 卡片排队：入队时再兜一层去重（prev 里可能已有同图案，例如连续两次 compile）。
      setAlgoCards((previous) => {
        const merged = [...previous, ...fresh.filter((id) => !previous.includes(id))];
        return merged;
      });
      // 批次 23：每发现一种写法，全产出永久 +0.5%（最多 +6.5%）。
      // 这是"研究算法比多叠一块吐纳更划算"的唯一长期依据。
      runtimeRef.current?.setInsightRate(insightRate(next.length));
      const rank = rankReached(known.length, next.length);
      const insightLine = awardedInsight > 0 ? ` · 悟道 +${awardedInsight}` : '';
      if (rank !== null) {
        showToast(`功法谱 ${next.length} / ${PATTERN_TOTAL} · ${rank.name}：${rank.line}（${insightBonusText(next.length)}）${insightLine}`);
      } else if (fresh.length > 0) {
        showToast(`刚发现「${patternDef(fresh[0] ?? 'linear').name}」· ${insightBonusText(next.length)}${insightLine}`);
      }
      // HUD 的功法谱行要刷新：把 found 计数塞进 lastHudKey 的派生源。
      lastHudKey = '';
    }

    // 首次挂载后立刻识别一次（存档里可能已经有符合条件的结构）。
    runtime.setInsightRate(insightRate(readFound(storage).length));
    recognizePatterns();

    // 任务 7B：离线结算触发。条件：有存档 && 有程序 && 本会话首次。
    // StrictMode 双挂载时，第一次挂载的结算结果暂存在 pendingOfflineReport，第二次挂载读取后清空。
    const hasSave = loaded.state !== null;
    const hasProgram = cache.length > 0;
    const alreadySettled = pendingOfflineReport !== null;
    if (hasSave && hasProgram && !alreadySettled && loaded.state !== null) {
      const currentSettings = readSettings(storage);
      const result = runtime.settleOffline({
        lastSeenAt: loaded.state.lastSeenAt,
        allowBreakthrough: currentSettings.settings.offlineBreakthrough,
      });
      if (result !== null) {
        pendingOfflineReport = result;
      }
    }
    // 读取暂存的离线报告（可能来自本次挂载，也可能来自 StrictMode 的第一次挂载）
    // 不在这里清空：StrictMode 的第二次挂载还要读它。清空的活交给 cleanup。
    const offlineReport = pendingOfflineReport;

    // 境界/心魔/惩罚倒计时是连续变化的，逐帧比上一次贵；这些字段量化后拼成 key，
    // 只有真正看得出来的变化（灵力整数、速率、心魔千分位、剩余 0.1 秒、境界四件套、stall）才重渲染。
    // 渡劫三件套按秒量化：蓄势 2 分钟不需要 60 次/秒的重渲染，剩余 1 秒一跳就够玩家看清。
    // 保底元进度的落盘闸门：attempt / realm 没变就不写，免得每帧碰 localStorage。
    let lastPityAttempt = 0;
    let lastPityRealm = -1;

    const loop = createLoop(runtime, (state) => {
      // 保底跨刷新：本境界第 N 次一变就写/清（成功、换境、清档都回到 1）。
      // 放在渲染闸门之前：玩家可能在这一帧就关页面。
      if (state.attempt !== lastPityAttempt || state.realm !== lastPityRealm) {
        lastPityAttempt = state.attempt;
        lastPityRealm = state.realm;
        if (state.attempt > 1) writePity(storage, { realm: state.realm, attempt: state.attempt });
        else clearPity(storage);
      }
      // 结算结果每出现一份新的就播报一次：引用相同 = 还是那一发，不重复说。
      if (state.lastChallenge !== seenChallenge) {
        seenChallenge = state.lastChallenge;
        lastHudKey = '';
        if (seenChallenge !== null) reportChallenge(seenChallenge);
      }
      const qi = Math.floor(state.qi);
      // 引导逐步推进靠墙钟停留时长（第 4 步的 5 秒），所以它必须在渲染闸门之前每帧都跑；
      // 它自己只在文案真变时改 tutBarSig，sig 进 key，闸门照样拦得住空转帧。
      syncTutorial(state);
      // 首次「可渡劫」：脉冲由 CSS 看相位，话由这里说一次（P0-C 第 4 项）。
      if (!readyToastShown && challengePhaseOf(state) === 'ready') {
        readyToastShown = true;
        showToast('存量已满，可以渡劫了');
      }

      // 批次 5：四个"状态变了但玩家看不见"的时刻。都在渲染闸门之前判定，
      // 否则 HUD 不重渲染的帧里这些事件会被一起跳过。
      const nowMs = wallClock.now();
      if (state.demon >= NOISE_LINE && prevDemon < NOISE_LINE && nowMs - lastMomentAt.noise >= MOMENT_COOLDOWN_MS.noise) {
        lastMomentAt = { ...lastMomentAt, noise: nowMs };
        pushMoment('noise');
      }
      prevDemon = state.demon;
      if (state.backlashTicks.length > prevBacklashCount) {
        prevBacklashCount = state.backlashTicks.length;
        if (nowMs - lastMomentAt.backlash >= MOMENT_COOLDOWN_MS.backlash) {
          lastMomentAt = { ...lastMomentAt, backlash: nowMs };
          pushMoment('backlash');
          setBacklashFlash(true);
          if (backlashFlashTimerRef.current !== null) clearTimeout(backlashFlashTimerRef.current);
          backlashFlashTimerRef.current = setTimeout(() => {
            backlashFlashTimerRef.current = null;
            setBacklashFlash(false);
          }, 600);
        }
      }
      // 批次 22：突破即掉落（在线渡劫、离线渡劫、演示跳关都走这一处）。
      if (artifactRealm !== state.realmIndex) {
        artifactRealm = state.realmIndex;
        // 境界变了：解锁文案与持有状态都要重算（不重算就会留着旧境界的标签）。
        setHud((previous) => ({ ...previous, artifacts: artifactRows(game.equippedArtifacts, artifactRealm, game.ownedArtifacts) }));
      }
      if (state.realmIndex !== lastRealmSeen) {
        lastRealmSeen = state.realmIndex;
        const drops = ARTIFACT_DROPS[state.realmIndex];
        if (drops !== undefined) grantArtifacts(drops, `${state.realmName}的渡劫奖励`);
      }
      if (state.daoFallback && !daoFallbackSeen) {
        daoFallbackSeen = true;
        showToast('心魔久踞不散 · 已堕入魔道（全产出 +12%，心魔增速翻倍）');
        lastHudKey = '';
      }
      if (state.sprintReached && !prevSprintReached) {
        // 试炼评分（批次 6）：把"达成"变成可比较的数字——产出、用了多少步、每步换多少灵力。
        // 没有这三个数，「多算一遍」和「省步」就没有共同的度量。
        const goal = state.sprintGoalQi ?? 0;
        // 2026-11-26：本境试炼首次达成也给悟道 +1（账本去重，重复达成不再发）。
        const trialInsight = awardSource(trialSource(state.realmIndex));
        const previousBest = bestMap[state.realmIndex] ?? null;
        if (previousBest === null || state.sprintPerQi > previousBest) {
          const nextMap: BestMap = { ...bestMap, [state.realmIndex]: state.sprintPerQi };
          bestMapRef.current = nextMap;
          setBestMap(nextMap);
          writeBest(storage, nextMap);
        }
        const bestLine = previousBest === null ? '这是第一次达成' : `上次最好 ${previousBest.toFixed(3)}`;
        const errandGoal = errandOf(state.realmIndex, 0).goal;
        if (errandGoal !== null && state.sprintPerQi >= errandGoal && trialMercyRealm !== state.realmIndex) {
          trialMercyRealm = state.realmIndex;
          showToast(`试炼优秀：效率 ${state.sprintPerQi.toFixed(2)} ≥ ${errandGoal.toFixed(1)} · 本境渡劫失败免罚`);
        }
        momentTextOverrides.set(
          'sprint',
          `试炼达成：60 秒产出 ${Math.floor(state.sprintProgressQi)}（目标 ${goal}）· 用了 ${state.sprintSteps} 步 · 效率 ${state.sprintPerQi.toFixed(3)} 灵力/步 · ${bestLine}。本境界蓄势减半${trialInsight > 0 ? ` · 悟道 +${trialInsight}` : ''}。`,
        );
        pushMoment('sprint');
      }
      prevSprintReached = state.sprintReached;
      if (state.stall !== null) pushMoment('stall');
      // 金丹解锁引灵/阵图：一次性说明「拖哪、阵图放哪、多少收益」，别只在工具箱里摆着。
      if (state.realmIndex >= 2) pushMoment('array');
      // 道具说明卡：拥有即提示一次（"什么时候能用"由玩家自己的进度决定，
      // 不按境界或时间硬塞）。玉简提醒"配循环"，算盘提醒"撞上限时再用"。
      if (game.equippedArtifacts.includes('jade') || game.ownedArtifacts.includes('jade')) pushMoment('art-jade');
      if (game.equippedArtifacts.includes('abacus') || game.ownedArtifacts.includes('abacus')) pushMoment('art-abacus');
      if (game.equippedArtifacts.includes('pearl') || game.ownedArtifacts.includes('pearl')) pushMoment('art-pearl');
      if (game.equippedArtifacts.includes('vase') || game.ownedArtifacts.includes('vase')) pushMoment('art-vase');
      if (game.equippedArtifacts.includes('pouch') || game.ownedArtifacts.includes('pouch')) pushMoment('art-pouch');
      const key = `${qi}|${state.rate}|${state.stall?.tick ?? -1}|${Math.round(state.demon * 1000)}|${Math.ceil(state.pauseRemainingMs / 100)}|${state.realmName}|${state.threshold}|${state.passivePerSec}|${state.canBreakthrough}|${Math.ceil(state.trialRemainingMs / 100)}|${Math.ceil(state.cooldownRemainingMs / 1000)}|${Math.ceil(state.chargeRemainingMs / 1000)}|${state.chargeReadyAt}|${state.attempt}|${state.insight}|${state.sprintGoalQi}|${Math.floor(state.sprintProgressQi)}|${state.sprintReached}|${tutBarSig}`;
      if (key === lastHudKey) return;
      lastHudKey = key;
      // 突破/渡劫成功之后工具箱跟着换（§4.3）：flyout 是打开时才渲染的，但已打开的面板要当场重建才看得见新块。
      applyToolbox(state.realmIndex);
      // 渡劫之后乘数换表：曲线跟着新境重算，否则「预计 X 秒」说的还是上一境的数字。
      // 只在境界真换过的那一帧动手，且这不算「玩家改了程序」，所以不会冒出对比行。
      if (state.realmIndex !== curveRealm) {
        curveRealm = state.realmIndex;
        syncCurve(cache[0] ?? null);
      }
        // 批次 33：起步卡。教程结束后，画布还没跑出东西时，把「下一步」放在画布左下角。
      if (tutActive) {
        coachRef.current = null;
      } else if (workspace.getBlocksByType('breath', false).length + workspace.getBlocksByType('gongfa_array', false).length === 0) {
        // 判据是「有没有动作块」，不是 rate：境界被动也会让 rate > 0。
        coachRef.current = { text: '① 把「吐纳」拖进「每 tick」下面的凹槽' };
      } else if (workspace.getBlocksByType('gongfa_repeat', false).length === 0) {
        coachRef.current = { text: '② 用「循环」包住吐纳：次数改成一个数字，产出同样涨' };
      } else if (!runtime.state().canChallenge) {
        coachRef.current = { text: '③ 攒到 1000 就点「可渡劫」' };
      } else {
        coachRef.current = null;
      }

      // 批次 28：runtime 的悟道增量同步到元进度（失败 +1，学功法花掉它）。
      if (state.insight > insightSynced) {
        const gained = state.insight - insightSynced;
        metaInsight += gained;
        insightSynced = state.insight;
        writeInsight(storage, metaInsight);
        refreshScriptures();
        // 批次 29：第一点悟道是最该被看见的一刻 —— 它解锁了藏经阁。
        if (learnedScriptures.length === 0 && metaInsight >= 1 && !scriptureHintShown) {
          scriptureHintShown = true;
          scriptureHighlightRef.current = true;
          window.setTimeout(() => { scriptureHighlightRef.current = false; lastHudKey = ''; }, 2600);
          lastHudKey = '';
          document.querySelector('.scriptures')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          showToast(`悟道 +${gained}：去「藏经阁」学一套上乘功法`);
        }
      }
      // 批次 24：考校达标 → 宽恕。逐帧同步（很便宜），达标立刻生效。
        const errand = errandOf(
          state.realmIndex,
          state.stepsThisTick > 0 ? state.rate / 10 / state.stepsThisTick : 0,
        );
        runtime.setFailureMercy(errand.mercy || trialMercyRealm === state.realmIndex);
      setHud((previous) => ({
        ...previous,
        qi,
        rate: state.rate,
        stall: state.stall,
        // 批次 5：步数与效率必须逐帧更新 —— 只放在 hudModel() 里只会更新"初始快照"，
        // 页面跑起来之后那行永远是 0（这次就踩了：hudModel 只被 useState 用过一次）。
        steps: {
          used: state.stepsThisTick,
          pool: state.budgetPool,
          perQi: state.stepsThisTick > 0 ? state.rate / 10 / state.stepsThisTick : 0,
        },
        realm: realmModel(state, algoFoundState),
        sprint: sprintModel(state, bestMapRef.current[state.realmIndex] ?? null),
        challenge: challengeModel(state),
        toolHint: toolHintOf(state),
        tutorial: tutBar,
        // 批次 7：下一步提示。cache 是宿主才知道的"有没有可执行程序"，
        // runtime 分不清"空画布"与"编译失败保留 lastGood"，所以这里传进去。
        nextStep: nextStepOf({
          state,
          hasProgram: cache.length > 0,
          breathBlocks: workspace.getBlocksByType('breath', false).length,
          hasRepeat: workspace.getBlocksByType('gongfa_repeat', false).length > 0,
        }),
        dao: state.dao,
        trace: state.trace,
        // 批次 19：积木库清单跟境界走（突破后新块要立刻出现在手机上）
        palette: toolboxForRealm(state.realmIndex, state.demo).contents.map((item) => item.type),
        // 批次 20：第一境三步目标。做完（或突破）就不再显示，避免长期占版面。
        insight: metaInsight,
        scriptures: scriptureRows(),
        scriptureSources: scriptureSourcesText(),
        formations: formationRows(),
        scriptureHighlight: scriptureHighlightRef.current,
        quest: state.realmIndex === 0
          ? [
              { label: '拖一块「吐纳」进「每 tick」', done: workspace.getBlocksByType('breath', false).length >= 1 },
              { label: '用「循环」包住吐纳', done: workspace.getBlocksByType('gongfa_repeat', false).length >= 1 },
              { label: '攒到 1000 · 点「可渡劫」', done: false },
            ]
          : [],
      }));
    });
    // 入门赠礼放在这里：grantArtifacts 里会调 pushMoment，而 pushMoment 在本行之前才初始化。
    if (game.ownedArtifacts.length === 0) {
      grantArtifacts(['jade'], '入门赠礼');
    }

    loop.start();

    // D5：只读调试句柄。Vite 的类型入口没进本项目的 tsconfig types，所以显式取一次 import.meta.env：
    // 构建时它会被换成字面量对象，正式构建里 DEV 就是 false，默认不挂；验收用 ?debug=1 打开。
    const debugVisible = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true
      || new URLSearchParams(window.location.search).has('debug');
    if (debugVisible) {
      window.__gongfa_debug = {
        state: () => runtime.state(),
        // 验收用：手动触发离线结算，绕过 localStorage 读取，并更新 UI
        settleOffline: (lastSeenAt: number) => {
          const result = runtime.settleOffline({
            lastSeenAt,
            allowBreakthrough: readSettings(storage).settings.offlineBreakthrough,
          });
          if (result !== null) {
            // 与 mount / 空窗路径共用同一个转换器，避免三处各写一遍字段
            setHud((previous) => ({ ...previous, retreat: toRetreatReport(result, runtime.state().realmName) }));
          }
          return result;
        },
        // 验收用：收起工具箱（需求变更 2026-11-21 验收 c）。引导期间 autoClose 被钉住，
        // 玩家点画布不会自动收起，所以验收要靠这个句柄模拟「目标消失」的状态。
        hideFlyout: () => {
          const flyout = workspace.getFlyout() as unknown as { hide?: () => void } | null;
          flyout?.hide?.();
        },
      };
    }

    setHud((previous) => {
      return {
        ...previous,
        notices: noticeList,
        corrupt: corrupted,
        warning: fallbackNotice,
        // 损坏那句在红字里（含备份 key），灰字只标这一次装载的来历，不重复两遍
        save: loaded.fresh ? ['新档 · 尚未落盘'] : ['档已装载'],
        retreat: offlineReport === null ? null : toRetreatReport(offlineReport, runtime.state().realmName),
      };
    });

    return () => {
      loop.stop();
      window.clearTimeout(resizeLater);
      window.removeEventListener('resize', resizeCanvas);
      window.removeEventListener('orientationchange', resizeCanvas);
      cleanupResizeObserver?.();
      window.removeEventListener('keydown', onDemoKey);
      window.removeEventListener('keydown', onPanelEsc);
      if (toastTimer !== null) clearTimeout(toastTimer);
      if (tutReleaseTimer !== null) clearTimeout(tutReleaseTimer);
      if (tutBadgeTimer !== null) clearTimeout(tutBadgeTimer);
      if (tutEndTimer !== null) clearTimeout(tutEndTimer);
      detachBook();
      detachArtifacts();
      challengeActionRef.current = null;
      pillActionRef.current = null;
      optimizeActionRef.current = null;
      traceFormationRef.current = null;
      trialPressRef.current = null;
      // 浮层是本地 state：StrictMode 的第二次挂载没有 demoPanelOpen，留着会挂着一块关不掉的面板。
      setDemoTrial(false);
      setOutcome(null);
      if (outcomeTimerRef.current !== null) clearTimeout(outcomeTimerRef.current);
      outcomeTimerRef.current = null;
      tutorialSkipRef.current = null;
      tutPaintedRef.current = null;
      if (debugVisible) delete window.__gongfa_debug;
      // StrictMode 的双挂载与真实卸载都走这里：先落一次档再拆工作区，别把刚搭的程序丢在内存里
      controller.flush();
      detachSave();
      saveRef.current = null;
      workspace.dispose();
    };
  }, []);

  const handleSettingsToggle = (key: 'offlineBreakthrough', value: boolean): void => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    writeSettings(createLocalStorageSaveStorage(), next);
  };

  const handleCloseRetreat = (): void => {
    setHud((previous) => ({ ...previous, retreat: null }));
  };

  // 结果层的点击跳过：不满 RESULT_HOLD_MS 一律整次忽略，不是「点了没反应」的 bug ——
  // 结算那一下玩家的手常常还压在按钮上，一出现就能点等于把动画闪掉，等于没给反馈。
  const handleDismissOutcome = (): void => {
    if (Date.now() - outcomeSinceRef.current < RESULT_HOLD_MS) return;
    if (outcomeTimerRef.current !== null) clearTimeout(outcomeTimerRef.current);
    outcomeTimerRef.current = null;
    setOutcome(null);
  };

  // 清档走 resetAllSaves 的死顺序：先断写入 → 再清键 → 再 reload。
  // 少第一步的话，reload 触发的 pagehide 会带着内存里的旧状态再 flush 一次，玩家看到的是「重置没生效」。
  // 道途（批次 7）：选中即写元进度（gongfa:dao:<slot>），并让 runtime 立刻重建 sink
  // （邪修的代价在 demonBase 上，sink 构造时固定，不重建就要等下一次读档才生效）。
  const handleChooseDao = (path: 'orthodox' | 'heretic'): void => {
    const rt = runtimeRef.current;
    if (rt === null) return;
    const storage = createLocalStorageSaveStorage();
    rt.setDao(path);
    writeDao(storage, path);
  };

  // 服丹（批次 8）：结果用 toast 说清楚——失败原因（冷却/心魔太低/存量不够）比成功更需要解释。
  const handleTakePill = (): void => {
    pillActionRef.current?.();
  };

  const handleResetSave = (): void => {    setModal({
      title: '重置存档',
      body: RESET_CONFIRM_TEXT,
      confirmText: '清空并重开',
      danger: true,
      onConfirm: () => {
        resetAllSaves({
          storage: createLocalStorageSaveStorage(),
          blockWrites: blockLocalStorageWrites,
          reload: () => window.location.reload(),
        });
      },
    });
  };

  // tut-N 是降对比度规则的作用域（P0-D）：引导没启动、已结束或已跳过都不带 class，一条压制规则都不会生效。
  // 结束态（step === null）也不带 —— 那句「自己试」不该再把别的元素压暗。
  const tutClass = hud.tutorial === null || hud.tutorial.step === null ? '' : ` tut tut-${hud.tutorial.step}`;

  return (
    <div className={`layout${tutClass}`}>
      {/* 批次 37：键盘可达性。Blockly 注入的 SVG 会吃掉 6 个 Tab 位，
          所以在最前面放一个跳转链接：第一下 Tab 就能直达主按钮。 */}
      <a
        className="skip-link"
        href="#main-action"
        onClick={(event) => {
          event.preventDefault();
          // 主按钮在不可渡劫时是 disabled，focus() 会静默失败；所以聚焦外层卡片（tabIndex=-1）。
          document.querySelector<HTMLElement>('#main-action')?.focus();
        }}
      >
        跳到主按钮
      </a>
      <div className="topbar">
        <span className="topbar-logo">代码修仙</span>
        <div className="topbar-right">
          {hud.demo && <span className="topbar-badge demo">演示 {DEMO_SPEED}×</span>}
          <span className="topbar-mode">在线 ×1.0 ｜ 闭关 ×0.6</span>
          <button className="topbar-settings" type="button" aria-label="设置" onClick={() => setDrawerOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>
      <div className="canvas-wrap" style={{ position: 'relative', height: '100%' }}>
        <div className="canvas" ref={containerRef} />
        {/* 国风挂件：纯装饰，pointer-events:none；只贴边，不压积木主区 */}
        <div className="canvas-ornaments" aria-hidden="true">
          <span className="canvas-mist" />
          <span className="canvas-seal">道</span>
          <span className="canvas-inscription">灵台方寸 · 一念通天</span>
        </div>
        {/* 手机：toast 回到文档流、起步卡仍是 fixed，两者会在底部压成一团；让 toast 先说完再出起步卡。 */}
        {!coachDismissed && hud.tutorial === null && hud.toast === null && coachRef.current !== null && (
          <CoachBanner text={coachRef.current.text} onDismiss={() => setCoachDismissed(true)} />
        )}
        {/* 批次 19：窄屏专用积木库。Blockly 的侧栏在手机上会吃掉半屏并把积木画到视口外，
            改成「点一下加一块」，画布独占整行。桌面隐藏，仍用原来的工具箱。 */}
        {hud.palette.length > 0 && (
          <div className="palette" role="toolbar" aria-label="积木库">
            {hud.palette.map((type) => (
              <button key={type} className="palette-item" type="button" onClick={() => { addBlockRef.current?.(type); }}>
                {BLOCK_SPECS[type]?.label ?? type}
              </button>
            ))}
          </div>
        )}
        <QiParticles rate={hud.rate} />
        {/* 走火入魔的整屏红闪：只闪 0.6 秒，pointer-events:none 不挡操作。 */}
        {backlashFlash && <div className="backlash-flash" aria-hidden="true" />}
        {/* 批次 6：应用内确认弹窗（替代 window.confirm）。 */}
        {modal !== null && <Modal request={modal} onClose={() => setModal(null)} />}
      </div>
      <Hud model={hud} onTakePill={handleTakePill} onLearnScripture={(id) => { learnScriptureRef.current?.(id); }} onLoadScripture={(id) => { loadScriptureRef.current?.(id); }} onTraceFormation={(id) => { traceFormationRef.current?.(id); }} onOpenCodex={() => setDrawerOpen(true)} onOptimize={() => { optimizeActionRef.current?.(); }} panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((open) => !open)} onBookAction={(action) => { bookActionRef.current?.(action); }} onChallenge={() => { challengeActionRef.current?.(); }} onArtifactAction={(id) => { artifactActionRef.current?.(id); }} onCloseRetreat={handleCloseRetreat} onChooseDao={handleChooseDao} />
      {/* 渡劫面板（批次 1）：正式玩法跟 phase 走；演示那块是 X 键举起来的，phase 永远不会是 trial。
          渲染在这里而不是 HUD 里：HUD 宽 300px 放不下「最显眼的一行」，窗口期玩家的手还在画布上。 */}
      {(hud.challenge.phase === 'trial' || demoTrial) && (
        <TrialPanel model={hud.challenge} demo={hud.demo} onPress={(mode) => { trialPressRef.current?.(mode); }} onParry={() => { trialPressRef.current?.('parry'); }} />
      )}
      {outcome !== null && <ChallengeResultLayer outcome={outcome} onDismiss={handleDismissOutcome} />}
      {hud.tutorial !== null && hud.tutorial.step !== null && (
        <TutorialBubble step={hud.tutorial.step} total={hud.tutorial.total} text={hud.tutorial.text} rev={tutRev} release={tutRelease} onPlaced={setTutPlaced} onStepPainted={onTutPainted} onAdvance={() => { tutAdvanceRef.current?.(); }} />
      )}
      {/* 批次 5：境界解锁的「新」角标（不挂 .tut class，避免界面变暗）。 */}
      {unlockNewIds.length > 0 && (
        <div className="toolbox-new-badges" aria-hidden="true">
          {unlockNewIds.map((id) => (
            <span key={id} className="toolbox-new-badge is-on" data-block={id}>
              新
            </span>
          ))}
        </div>
      )}
      {hud.tutorial !== null && <TutorialBar model={hud.tutorial} mini={tutPlaced && hud.tutorial.step !== null} onSkip={() => { tutorialSkipRef.current?.(); }} onAdvance={() => { tutAdvanceRef.current?.(); }} />}
      {/* 批次 3：算法发现卡片（右上角，3 秒自动消失）。 */}
      {algoCards.length > 0 && (() => {
        const first = algoCards[0];
        return first === undefined ? null : <AlgorithmCard key={first} patternId={first} onDismiss={handleDismissAlgoCard} />;
      })()}
      {drawerOpen && (
        <div className="settings-drawer-overlay" onClick={() => setDrawerOpen(false)}>
          <div className="settings-drawer" onClick={(e) => e.stopPropagation()}>
            <button className="settings-drawer-close" type="button" onClick={() => setDrawerOpen(false)} aria-label="关闭设置">✕</button>
            <p className="settings-drawer-title">设置</p>
            <div className="settings-drawer-item">
              <label>
                <input
                  type="checkbox"
                  checked={settings.offlineBreakthrough}
                  onChange={(e) => handleSettingsToggle('offlineBreakthrough', e.target.checked)}
                />
                闭关时自动渡劫（60% 成功率，失败不扣灵力）
              </label>
            </div>
            {hud.demo && (
              <div className="settings-drawer-item">
                <p style={{ fontSize: '12px', opacity: 0.6, lineHeight: 1.6, margin: 0 }}>
                  演示模式：点「可渡劫」当场按 85% 结算，无 10 秒窗口。
                  <br />
                  X 键开面板：面板内「确认冲关」= 85% 当场结算；不按就一直开着（演示里根本没有 10 秒窗口，放手不会结算）。
                </p>
              </div>
            )}
            {/* 批次 3：功法谱列表（设置抽屉里）。 */}
            <div className="patterns-drawer">
              <p className="patterns-drawer-title">功法谱 {algoFound.length} / {hud.realm.patterns.length}</p>
              <ul className="patterns-drawer-list">
                {hud.realm.patterns.map((pattern) => (
                  <li key={pattern.id} className={`patterns-drawer-item${pattern.found ? ' is-found' : ''}`}>
                    <span className="patterns-drawer-check">{pattern.found ? '✓' : '○'}</span>
                    <div className="patterns-drawer-content">
                      <p className="patterns-drawer-name">{pattern.name}</p>
                      <p className="patterns-drawer-algorithm">{pattern.algorithm}</p>
                      {/* 已发现的给「一句教学」，未发现的给「怎么搭」——图鉴要既浅又有深度。 */}
                      {pattern.found
                        ? <p className="patterns-drawer-teach">{pattern.teach}</p>
                        : <p className="patterns-drawer-requires">需要：{pattern.requires}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {/* 批次 6：道具指南（玩家问"这是干什么的、哪个时期用"）。 */}
            <div className="patterns-drawer">
              <p className="patterns-drawer-title">道具指南</p>
              <ul className="patterns-drawer-list">
                {ARTIFACT_GUIDE.map((row) => (
                  <li key={row.id} className="patterns-drawer-item is-found">
                    <span className="patterns-drawer-check">{row.glyph}</span>
                    <div className="patterns-drawer-content">
                      <p className="patterns-drawer-name">{row.name}</p>
                      <p className="patterns-drawer-algorithm">{row.effect}</p>
                      <p className="patterns-drawer-requires">什么时候用：{row.when}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            {/* 批次 10：修仙体系与世界观（评审：缺的设定用说明承接，但必须让玩家点得到）。
                折叠默认收起：抽屉只有 300px，全展开会把「重置存档」顶出首屏。 */}
            <details className="codex-section">
              <summary>道途与流派</summary>
              <p>四境界：炼气 → 筑基 → 金丹 → 元婴。化神之后的劫，本门尚未开启。</p>
              <p>流派：守正 / 入魔已开放，一次定终身；剑修、丹修、阵修、符修、体修在后续版本。</p>
              <p>灵根：开局由命格（种子）决定，上品心魔涨得慢、下品更快，不影响产出。</p>
              <p>丹药：存量换心魔，心魔条旁「服丹」；丹炉温养需要 30 秒。</p>
            </details>
            <details className="codex-section">
              <summary>世界观</summary>
              <p>洞府：你的画布。宗门与师尊：尚未出现。</p>
              <p>符箓＝条件，阵法＝循环，玉简＝缓存：这三句是这个世界的底层规则。</p>
              <p>转世与飞升：元婴之后的路，留给下一次更新。</p>
            </details>
            {/* 2026-11-26：世界观资产扩充——境界/界域/宗门/丹药/法宝/灵根，每条带计算机对照。 */}
            <details className="codex-section">
              <summary>世界观图鉴 · 境界/界域/宗门</summary>
              <WorldCodex />
            </details>
            <details className="codex-section">
              <summary>怎么看那几个数</summary>
              <p><b>本 tick N / 200 步</b>：这一 tick 执行了多少条指令。撞满会变红，说明程序被预算截断。</p>
              <p><b>效率 X 灵力/步</b>：本 tick 产出 ÷ 步数。两个程序每秒产出一样时，效率高的那个更抗预算。</p>
              <p><b>产出曲线</b>：青线是灵力累计、红线是心魔；虚线是突破阈值。红线撞到 1.0 就是走火入魔。</p>
              <p><b>试炼</b>：60 秒窗口内的产出与步数，达成目标可把本境蓄势减半；「本境最好」是历史最高效率。</p>
              <p><b>观测（Trace）</b>：最近 60 秒每秒一条：峰值/平均步数/心魔峰值 + 当前值。它只存在内存里，刷新就清空——它是"刚才发生了什么"，不是进度。</p>
            </details>
            <details className="codex-section">
              <summary>炼器炉为什么不是免费优化</summary>
              <p>它把「连续 N 块相同动作」折叠成「循环 N 次」：<b>IR 指令变少</b>（代码短了），但<b>每 tick 步数变多</b>（循环每次迭代都要执行 LOOP_BEGIN/LOOP_END）。</p>
              <p>如果折叠的是<b>吐纳</b>，心魔增速还会 ×1.5：循环把动作深度从 0 提到 1，而心魔增长按「1 + 0.5 × 深度」算。</p>
              <p>调息折叠是真等价（调息不涨心魔）。所以炼器炉只给数字，点不点由你决定。</p>
            </details>
            <details className="codex-section">
              <summary>双修：为什么阵法、循环、玉简可以一起用</summary>
              <p>没有「阵位」限制：<b>200 步预算就是唯一的裁判</b>。想叠就叠，叠到撞墙为止。</p>
              <p>实测金丹同一程序：循环 5 次普通吐纳 <b>919/秒 · 12 步</b>；加 3 眼阵图 <b>1238/秒 · 27 步</b>；再加玉简 <b>983/秒 · 23 步</b>。</p>
              <p>注意玉简那一行：命中免的是「动作步」，<b>阵眼的步照付</b>，所以它会用产出换步数——这正是双修需要权衡的地方，而不是无脑叠满。</p>
            </details>
            <details className="codex-section">
              <summary>沙漏为什么要付启动成本</summary>
              <p>同一 tick 里，第 k 次相同动作只值「1/(1+0.25(k-1))」——越堆越不值钱。</p>
              <p>「沙漏」把一段动作攒成新的一批：批内重新从第 1 次算，边际递减清零；代价是每批固定 4 步（3 步配置 + 它自己一条指令）。</p>
              <p>所以批不是越大越好，也不是越小越好：<b>批越大，摊得越薄；批越多，启动费越贵</b>。</p>
            </details>
            <details className="codex-section">
              <summary>阵修推演在算什么</summary>
              <p>它算的是**成本**，不是真的多节点执行：加速 ≈ 节点数 × 全节点成功率 ÷（1 + 同步成本 × (节点数-1) ÷ 工作步数）。</p>
              <p>所以加节点有上限：同步成本越高、工作步数越少，越早遇到最优点（面板会直接告诉你最优节点数）。</p>
              <p>故障率按 (1-p)^N 叠乘——节点越多，全节点都不出错的概率越低。这就是「护山大阵」要投票的原因。</p>
              <p><b>副本不是越多越好</b>：法定人数 = ⌊副本/2⌋+1。2 副本要求两票都在，比单副本更脆；3 副本才真正容忍 1 份掉线。奇数副本更划算。</p>
            </details>
            <div className="settings-drawer-item settings-drawer-danger">
              <button className="settings-reset" type="button" onClick={handleResetSave}>
                重置存档
                <span className="settings-reset-hint">清空全部进度，无法恢复</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
