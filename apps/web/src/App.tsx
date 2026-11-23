import { useEffect, useRef, useState } from 'react';
// 只引 blockly/core：blockly 主入口会顺带注册标准库积木（controls_*、logic_*），我们用不到它们，
// 引了还会和自定义块型抢注册、往 console 刷覆盖警告。
import * as Blockly from 'blockly/core';
import * as zhHans from 'blockly/msg/zh-hans';
import {
  BLOCK_DEFINITIONS,
  PROGRAM_ID,
  compileWorkspace,
  GONGFA_THEME,
  STARTER_WORKSPACE_JSON,
  type WorkspaceJson,
} from '@gongfa/blocks';
import { AUTO_RATE, BACKLASH_LINE, CHALLENGE_TRIAL_MS, FAILURE_QI_MULT, MANUAL_RATE, PREVIEW_SECONDS, PATTERN_TOTAL, PATTERNS, activeSlot, bookEvent, derivePhase, loadGame, newGameState, patternsOf, readSettings, shapeOf, writeSettings, type BookDef, type BookEvent, type BookPhase, type CurvePreview, type GameState, type LoadResult, type OfflineResult, type PatternId, type Program, type SaveStorage, Qi } from '@gongfa/core';
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
import { lockedCount, toolboxForRealm } from './game/toolbox';
import { END_DWELL_MS, NEW_BADGE_MS, RELEASE_AFTER_DRAG_MS, TUTORIAL_PLAY_MS_MAX, flyoutFocusType, hiddenToolboxTypes, nextTutorialStep, readTutorialDone, releasedBlocks, resumeTutorialStep, tutorialActiveAt, tutorialBar, writeTutorialDone, type ReleasedBlock, type TutorialBarModel, type TutorialNumbers, type TutorialPlayStep, type TutorialStep } from './game/tutorial';
import { readFound, writeFound } from './game/found';
import { ChallengeResultLayer, Hud, TrialPanel, TutorialBar, type ArtifactRow, type BookAction, type BookModel, type ChallengeModel, type ChallengeOutcome, type ChallengePhase, type CorruptLineModel, type CurveCompare, type CurveModel, type HudModel, type RealmModel, type RetreatReport, type SprintModel } from './game/hud';
import { TutorialBubble } from './game/tutorialBubble';
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
    calmText: CALM_DEMON_DELTA === null ? null : `调息 ${CALM_DEMON_DELTA}/次`,
    patterns: PATTERNS.map((pattern) => ({
      id: pattern.id,
      name: pattern.name,
      algorithm: pattern.algorithm,
      requires: pattern.requires,
      found: found.includes(pattern.id),
    })),
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
function sprintModel(state: RuntimeState): SprintModel {
  return {
    goalQi: state.sprintGoalQi,
    progressQi: state.sprintProgressQi,
    windowMs: state.sprintWindowMs,
    reached: state.sprintReached,
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
function artifactRows(equippedIds: readonly string[]): readonly ArtifactRow[] {
  return ARTIFACT_CATALOGUE.artifacts.map((artifact) => ({
    id: artifact.id,
    name: artifact.name.zh,
    effect: describeArtifact(artifact),
    equipped: equippedIds.includes(artifact.id),
  }));
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

function hudModel(state: RuntimeState, book: BookModel, found: readonly PatternId[], extra: Pick<HudModel, 'errors' | 'corrupt' | 'save' | 'notices' | 'artifacts' | 'retreat' | 'curve' | 'toast' | 'tutorial'>): HudModel {
  return {
    qi: Math.floor(state.qi),
    rate: state.rate,
    stall: state.stall,
    realm: realmModel(state, found),
    curve: extra.curve,
    sprint: sprintModel(state),
    challenge: challengeModel(state),
    toolHint: toolHintOf(state),
    artifacts: extra.artifacts,
    book,
    errors: extra.errors,
    corrupt: extra.corrupt,
    save: extra.save,
    notices: extra.notices,
    retreat: extra.retreat,
    toast: extra.toast,
    tutorial: extra.tutorial,
    demo: state.demo,
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
  return { line: loaded.summary, detail };
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
  const [hud, setHud] = useState<HudModel>(hudModel(booted, { phase: 'IDLE', text: '未装载功法 · 心魔 ×1.00', loadable: 0 }, [], { errors: [], corrupt: null, save: ['读取存档…'], notices: [], artifacts: [], retreat: null, curve: NO_CURVE, toast: null, tutorial: null }));
  const [settings, setSettings] = useState(initialSettings.settings);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 引导气泡（需求变更 2026-11-21）：贴得上目标 → 底部条降级成「n/6 · 跳过引导」；贴不上 → 底部条说完整文案。
  const [tutPlaced, setTutPlaced] = useState(false);
  // 「工具箱重建过了」的计数：updateToolbox 换掉整棵 flyout DOM，气泡要立刻重挂高亮，不等 400ms 轮询。
  const [tutRev, setTutRev] = useState(0);
  // 需求 15：工具箱刚放出来的那几块，2 秒内挂「新」角标并把气泡借过去。
  const [tutRelease, setTutRelease] = useState<readonly ReleasedBlock[]>(NO_RELEASE);
  // 批次 3：功法谱发现记录。algoFound 从 localStorage 初始化，algoCards 是待展示的卡片队列。
  const [algoFound, setAlgoFound] = useState<readonly PatternId[]>([]);
  const [algoCards, setAlgoCards] = useState<readonly PatternId[]>([]);
  const algoCardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const trialPressRef = useRef<((mode: 'manual' | 'auto') => void) | null>(null);

  // 批次 3：功法谱卡片队列。每张卡 3 秒，自动消失后弹出下一张。
  useEffect(() => {
    if (algoCards.length === 0) return;
    // 如果已经有定时器在跑，不重复起（卡片会按顺序自动轮转）。
    if (algoCardTimerRef.current !== null) return;
    algoCardTimerRef.current = setTimeout(() => {
      algoCardTimerRef.current = null;
    }, 3_000);
  }, [algoCards]);

  const handleDismissAlgoCard = (): void => {
    setAlgoCards((previous) => previous.slice(1));
    if (algoCardTimerRef.current !== null) {
      clearTimeout(algoCardTimerRef.current);
      algoCardTimerRef.current = null;
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    const runtime = runtimeRef.current;
    if (container === null || runtime === null) return;

    const storage = createLocalStorageSaveStorage();
    const demoFlags = createSessionFlagStore();

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
    let tutStepAt = 0;
    // 需求 13：已经由「气泡上屏」起过表的那一步。每步只认第一次报告，重复报告会把计时一推再推。
    let tutArmedFor: TutorialPlayStep | null = null;
    let tutBar: TutorialBarModel | null = null;
    let tutBarSig = '';
    let tutReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    let tutEndTimer: ReturnType<typeof setTimeout> | null = null;
    // 需求 15：释放窗口（2 秒）里刚放出来的块 id。空 = 不在窗口内。
    let tutNewIds: readonly string[] = [];
    let tutBadgeTimer: ReturnType<typeof setTimeout> | null = null;

    // 工具箱按境界门控（契约 §4.3 的解锁列）：炼气只给 4 块，筑基起补「如果 / 循环」。
    // ?demo=1 全开（01-design §11.4「演示模式强制全开」）。Blockly 的 updateToolbox 重建整棵 flyout，
    // 但 flyout 是「打开时才渲染」的，所以只换 ToolboxJson 不会碰画布上已有的积木，也不触发 compile。
    // 引导的临时藏块（hidden）叠在同一份 ToolboxJson 上、走同一个入口，才不会出现两份工具箱口径。
    const workspace = Blockly.inject(container, {
      theme: Blockly.Theme.defineTheme(GONGFA_THEME.name, GONGFA_THEME as unknown as ThemeConfig),
      toolbox: toolboxForRealm(booted.realmIndex, booted.demo) as unknown as NonNullable<InjectOptions['toolbox']>,
    });
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
    // 引导期间钉住工具箱（批准）：Blockly 的 flyout 默认 autoClose=true，玩家随手点一下画布它就整棵
    // display:none，第 1/3/5 步的气泡天天「目标消失」—— 那是常态不是边角情况。引导一停就还原。
    // setAutoClose 不在 IFlyout 接口上（在 Flyout 实现里），按形状取，和上面 RenderedBlock 同一手法。
    type FlyoutAutoClose = { readonly setAutoClose: (value: boolean) => void };
    const pinFlyout = (): void => {
      (workspace.getFlyout() as unknown as FlyoutAutoClose | null)?.setAutoClose(!tutActive);
    };
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
    const corrupted = corruptReport(storage, loaded);
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
    // 批次 3：功法谱发现记录从 localStorage 初始化（按槽隔离）。
    const slot = activeSlot(storage);
    let algoFoundState: readonly PatternId[] = readFound(storage, slot);
    setAlgoFound(algoFoundState);
    let noticeList: readonly string[] = [...loaded.notices, ...(grant.notice === null ? [] : [grant.notice])];
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
        // O2：IDLE / LOADED / DIRTY 直接覆盖 + 灰字；FROZEN 的个人程序不在任何一本书里，覆盖前先问一句
        if (bookPhase === 'FROZEN' && !window.confirm('将覆盖你已固化的个人功法，且无法恢复，确定？')) return;
        if (target.book === null) {
          pushActionErrors(target.errors);
          return;
        }
        game = { ...game, equippedBook: target.book.id, ownedBooks: [...new Set([...game.ownedBooks, target.book.id])] };
        reloadCanvas(target.book.workspace);
        pushNotice(`已用《${target.book.name.zh}》覆盖当前程序`);
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
      setHud((previous) => ({ ...previous, artifacts: artifactRows(game.equippedArtifacts) }));
    };
    syncArtifacts();

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

    // HUD 的渲染闸门：逐帧把看得出来的变化量化成 key，key 不变就不重渲染。
    // 声明在这里是因为渡劫回调点完要把它清空 —— 结算改了 chargeReadyAt / attempt / insight，
    // 那三个字段不在 key 里，不清就会等下一次数字变化才刷新按钮。
    let lastHudKey = '';
    // 上一次播报过的结算（同一份引用 = 同一发），用来把托管结算也只说一次。
    let seenChallenge: ChallengeResult | null = null;

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
    challengeActionRef.current = (): void => {
      // 引导把它当「这一套他会了」：点过就一直算点过（第 5 步不设单独跳过，裁定 3）。
      tutPressed = true;
      const result = runtime.pressChallenge();
      if (result.phase === 'trial') {
        lastHudKey = '';
        pushNotice(`渡劫开始：${(CHALLENGE_TRIAL_MS / 1000).toFixed(0)} 秒内点「立即冲关」按 ${(MANUAL_RATE * 100).toFixed(0)}% 算，放手则按 ${(AUTO_RATE * 100).toFixed(0)}% 托管`);
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
    trialPressRef.current = (mode: 'manual' | 'auto'): void => {
      closeDemoPanel();
      const result = runtime.pressChallenge(mode);
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
      };
    };

    // 需求 13 的起表口：气泡把「这一步的 n/6 已经画到屏上」报回来，那一刻才许开始数 3 秒。
    // boot 与翻页那两处仍然先写一份兜底时间：气泡万一贴不上、报告丢了，引导不能永远停在第 1 步，
    // 但报告一旦到达就以报告为准 —— 停留是给眼睛的，状态机不该替眼睛提前起表。
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
        { breath, calm, qi: state.qi, demon: state.demon, hasCompare: lastCompare !== null, pressedChallenge: tutPressed },
        wallClock.now() - tutStepAt,
      );
      if (next !== tutStep) {
        tutStep = next;
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
            // 引导没了，工具箱该还给玩家自己开关。
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
      if (!window.confirm('演示重置：清空本机全部修仙存档并回到新档？\n灵力、境界、心魔、功法书、道具、引导记录都会没。')) return;
      requestDemoReset(demoFlags);
      window.location.reload();
    };
    window.addEventListener('keydown', onDemoKey);

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
    };

    workspace.addChangeListener(compile);
    compile();

    // 批次 3：算法识别。引导期间不识别（裁定 5），引导结束或跳过的当下立刻识别一次。
    // 识别结果写入 localStorage（按槽隔离），并触发卡片队列与 HUD 更新。
    const recognizePatterns = (): void => {
      if (tutActive) return;
      const program = cache[0];
      if (program === undefined) return;
      const shape = shapeOf(program.code, game.equippedArtifacts);
      const hits = patternsOf(shape);
      const fresh = hits.filter((id) => !algoFoundState.includes(id));
      if (fresh.length === 0) return;
      const next = [...algoFoundState, ...fresh];
      algoFoundState = next;
      setAlgoFound(next);
      writeFound(storage, slot, next);
      // 卡片排队：一次弹一张，每张 3 秒（ALGO_CARD_MS）。
      setAlgoCards((previous) => [...previous, ...fresh]);
      // 集齐 4 个 → 一次性 toast。
      if (next.length === PATTERN_TOTAL && next.length - fresh.length < PATTERN_TOTAL) {
        showToast('已通晓基础算法 · 道统 +1');
      }
      // HUD 的功法谱行要刷新：把 found 计数塞进 lastHudKey 的派生源。
      lastHudKey = '';
    };

    // 首次挂载后立刻识别一次（存档里可能已经有符合条件的结构）。
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
    const loop = createLoop(runtime, (state) => {
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
      setHud((previous) => ({
        ...previous,
        qi,
        rate: state.rate,
        stall: state.stall,
        realm: realmModel(state, algoFoundState),
        sprint: sprintModel(state),
        challenge: challengeModel(state),
        toolHint: toolHintOf(state),
        tutorial: tutBar,
      }));
    });
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
        // 损坏那句在红字里（含备份 key），灰字只标这一次装载的来历，不重复两遍
        save: loaded.fresh ? ['新档 · 尚未落盘'] : ['档已装载'],
        retreat: offlineReport === null ? null : toRetreatReport(offlineReport, runtime.state().realmName),
      };
    });

    return () => {
      loop.stop();
      window.removeEventListener('keydown', onDemoKey);
      if (toastTimer !== null) clearTimeout(toastTimer);
      if (tutReleaseTimer !== null) clearTimeout(tutReleaseTimer);
      if (tutBadgeTimer !== null) clearTimeout(tutBadgeTimer);
      if (tutEndTimer !== null) clearTimeout(tutEndTimer);
      detachBook();
      detachArtifacts();
      challengeActionRef.current = null;
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
  const handleResetSave = (): void => {
    if (!window.confirm(RESET_CONFIRM_TEXT)) return;
    resetAllSaves({
      storage: createLocalStorageSaveStorage(),
      blockWrites: blockLocalStorageWrites,
      reload: () => window.location.reload(),
    });
  };

  // tut-N 是降对比度规则的作用域（P0-D）：引导没启动、已结束或已跳过都不带 class，一条压制规则都不会生效。
  // 结束态（step === null）也不带 —— 那句「自己试」不该再把别的元素压暗。
  const tutClass = hud.tutorial === null || hud.tutorial.step === null ? '' : ` tut tut-${hud.tutorial.step}`;

  return (
    <div className={`layout${tutClass}`}>
      <div className="topbar">
        <span className="topbar-logo">代码修仙</span>
        <div className="topbar-right">
          {hud.demo && <span className="topbar-badge demo">演示 {DEMO_SPEED}×</span>}
          {!hud.demo && <span className="topbar-badge">在线</span>}
          <span className="topbar-mode">在线 ×1.0 ｜ 闭关 ×0.6</span>
          <button className="topbar-settings" type="button" aria-label="设置" onClick={() => setDrawerOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>
      <div style={{ position: 'relative', height: '100%' }}>
        <div className="canvas" ref={containerRef} />
        <QiParticles rate={hud.rate} />
      </div>
      <Hud model={hud} onBookAction={(action) => { bookActionRef.current?.(action); }} onChallenge={() => { challengeActionRef.current?.(); }} onArtifactAction={(id) => { artifactActionRef.current?.(id); }} onCloseRetreat={handleCloseRetreat} />
      {/* 渡劫面板（批次 1）：正式玩法跟 phase 走；演示那块是 X 键举起来的，phase 永远不会是 trial。
          渲染在这里而不是 HUD 里：HUD 宽 300px 放不下「最显眼的一行」，窗口期玩家的手还在画布上。 */}
      {(hud.challenge.phase === 'trial' || demoTrial) && (
        <TrialPanel model={hud.challenge} demo={hud.demo} onPress={(mode) => { trialPressRef.current?.(mode); }} />
      )}
      {outcome !== null && <ChallengeResultLayer outcome={outcome} onDismiss={handleDismissOutcome} />}
      {hud.tutorial !== null && hud.tutorial.step !== null && (
        <TutorialBubble step={hud.tutorial.step} total={hud.tutorial.total} text={hud.tutorial.text} rev={tutRev} release={tutRelease} onPlaced={setTutPlaced} onStepPainted={onTutPainted} />
      )}
      {hud.tutorial !== null && <TutorialBar model={hud.tutorial} mini={tutPlaced && hud.tutorial.step !== null} onSkip={() => { tutorialSkipRef.current?.(); }} />}
      {/* 批次 3：算法发现卡片（右上角，3 秒自动消失）。 */}
      {algoCards.length > 0 && (() => {
        const first = algoCards[0];
        return first === undefined ? null : <AlgorithmCard patternId={first} onDismiss={handleDismissAlgoCard} />;
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
                      {!pattern.found && <p className="patterns-drawer-requires">需要：{pattern.requires}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
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
