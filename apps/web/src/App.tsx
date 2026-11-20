import { useEffect, useRef, useState } from 'react';
// 只引 blockly/core：blockly 主入口会顺带注册标准库积木（controls_*、logic_*），我们用不到它们，
// 引了还会和自定义块型抢注册、往 console 刷覆盖警告。
import * as Blockly from 'blockly/core';
import * as zhHans from 'blockly/msg/zh-hans';
import {
  BLOCK_DEFINITIONS,
  compileWorkspace,
  GONGFA_THEME,
  STARTER_WORKSPACE_JSON,
  type WorkspaceJson,
} from '@gongfa/blocks';
import { AUTO_RATE, CHALLENGE_TRIAL_MS, FAILURE_QI_MULT, MANUAL_RATE, PREVIEW_SECONDS, bookEvent, derivePhase, loadGame, newGameState, readSettings, writeSettings, type BookDef, type BookEvent, type BookPhase, type CurvePreview, type GameState, type LoadResult, type OfflineResult, type Program, type SaveStorage } from '@gongfa/core';
import { createLocalStorageSaveStorage, wallClock } from './adapters/storage';
import { randomSeed } from './adapters/seed';
import { createSaveController, type SaveSnapshot } from './game/save';
import { createRuntime, urlSeed, type ChallengeResult, type Runtime, type RuntimeState } from './game/runtime';
import { createLoop } from './game/loop';
import { BOOK_CATALOGUE, STARTER_BOOK_ID, bookById, grantStarterBook } from './game/books';
import { ARTIFACT_CATALOGUE, describeArtifact, equipmentFor } from './game/artifacts';
import { lockedCount, toolboxForRealm } from './game/toolbox';
import { Hud, type ArtifactRow, type BookAction, type BookModel, type ChallengeModel, type ChallengePhase, type CorruptLineModel, type CurveCompare, type CurveModel, type HudModel, type RealmModel, type RetreatReport, type SprintModel } from './game/hud';

type InjectOptions = NonNullable<Parameters<typeof Blockly.inject>[1]>;
type ThemeConfig = Parameters<typeof Blockly.Theme.defineTheme>[1];
type SerializedState = Parameters<typeof Blockly.serialization.workspaces.load>[0];
type SaveBridge = ReturnType<typeof createSaveController>;

// D5：验收与回放用的只读句柄（state() 的实时视图，含 noiseTicks / backlashTicks / tick）。
// 只在 DEV 或 ?debug=1 时挂，正式构建默认不挂；卸载时删掉，不留上一份会话的 runtime。
declare global {
  interface Window {
    __gongfa_debug?: {
      readonly state: () => RuntimeState;
      readonly settleOffline?: (lastSeenAt: number) => OfflineResult | null;
    } | undefined;
  }
}

// 进度条和文案共用的境界视图：字段全部来自 runtime.state()，HUD 侧不做任何算术。
function realmModel(state: RuntimeState): RealmModel {
  return {
    name: state.realmName,
    threshold: state.threshold,
    passivePerSec: state.passivePerSec,
    canBreakthrough: state.canBreakthrough,
    pauseRemainingMs: state.pauseRemainingMs,
    demon: state.demon,
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
    chargeRemainingMs: state.chargeRemainingMs,
    trialRemainingMs: state.trialRemainingMs,
    cooldownRemainingMs: state.cooldownRemainingMs,
    attempt: state.attempt,
    insight: state.insight,
    demo: state.demo,
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

// 曲线预览的空视图：编译失败或凹槽空着时整块面板不出现 —— 画一条没在跑的曲线是假话。
const NO_CURVE: CurveModel = { points: [], threshold: 0, etaSec: null, reachesInWindow: false, seconds: PREVIEW_SECONDS, compare: null, truncated: false };

// toast 的停留时长：要够读完一句话，又不至于挡在玩家眼前不走（HUD 窄栏没有别的东西可看）。
const TOAST_MS = 6_000;

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
  };
}

function hudModel(state: RuntimeState, book: BookModel, extra: Pick<HudModel, 'errors' | 'corrupt' | 'save' | 'notices' | 'artifacts' | 'retreat' | 'curve' | 'toast'>): HudModel {
  return {
    qi: Math.floor(state.qi),
    rate: state.rate,
    stall: state.stall,
    realm: realmModel(state),
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
  // 种子只在这里掷一次，新档的 GameState 与 runtime 都从 runtime.state().seed 取同一个值。
  // ?seed= 优先（验收 5 要同种子复现）；有存档时 restore() 把 seed 换成存档里那份。
  // markDirty 走 saveRef 现取：控制器要到 useEffect 里才建出来，构造时只能留一个晚绑定的闭包。
  // 渡劫结算和蓄势起算都要立刻标脏 —— chargeReadyAt 不落盘，刷新就得重新等满 2 分钟。
  if (runtimeRef.current === null) runtimeRef.current = createRuntime({ seed: urlSeed() ?? randomSeed(), markDirty: () => saveRef.current?.markDirty() });
  const booted = runtimeRef.current.state();
  const initialSettings = readSettings(createLocalStorageSaveStorage());
  const [hud, setHud] = useState<HudModel>(hudModel(booted, { phase: 'IDLE', text: '未装载功法 · 心魔 ×1.00', loadable: 0 }, { errors: [], corrupt: null, save: ['读取存档…'], notices: [], artifacts: [], retreat: null, curve: NO_CURVE, toast: null }));
  const [settings, setSettings] = useState(initialSettings.settings);

  useEffect(() => {
    const container = containerRef.current;
    const runtime = runtimeRef.current;
    if (container === null || runtime === null) return;

    const storage = createLocalStorageSaveStorage();
    // 工具箱按境界门控（契约 §4.3 的解锁列）：炼气只给 4 块，筑基起补「如果 / 循环」。
    // ?demo=1 全开（01-design §11.4「演示模式强制全开」）。Blockly 的 updateToolbox 重建整棵 flyout，
    // 但 flyout 是「打开时才渲染」的，所以只换 ToolboxJson 不会碰画布上已有的积木，也不触发 compile。
    let toolboxRealm = booted.realmIndex;
    const toolboxJson = (index: number): NonNullable<InjectOptions['toolbox']> =>
      toolboxForRealm(index, booted.demo) as unknown as NonNullable<InjectOptions['toolbox']>;
    const workspace = Blockly.inject(container, {
      theme: Blockly.Theme.defineTheme(GONGFA_THEME.name, GONGFA_THEME as unknown as ThemeConfig),
      toolbox: toolboxJson(toolboxRealm),
    });
    const syncToolbox = (index: number): void => {
      if (index === toolboxRealm) return;
      toolboxRealm = index;
      workspace.updateToolbox(toolboxJson(index) as unknown as Parameters<typeof workspace.updateToolbox>[0]);
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
    };

    // 任务 6.5：「可渡劫」的唯一入口。点击本身只可能带来两种新信息：
    // ① 蓄势就绪 → 开启 10 秒挑战；② 前置条件没满足（惩罚 / 阈值 / 末境 / 冷却 / 蓄势）→ 红字。
    // 当场结算（手动确认、演示模式）与到点结算（托管）都由 reportChallenge 说。
    challengeActionRef.current = (): void => {
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

    // 曲线预览（任务 8 P0-B）：画布一变就重算，玩家不必拿 100 秒去验证一个猜想。
    // 对比行的基线是「上一次预览的模型速率」，不是 state.rate —— 后者含杂念折扣，同一份程序会报出两个「每秒」。
    // 基线还带 realmIndex：渡劫换了乘数表，拿上一境的数字做百分比是说假话。
    let curveBase: { readonly perSec: number; readonly realmIndex: number } | null = null;
    let lastCompare: CurveCompare | null = null;
    let curveRealm = booted.realmIndex;
    let toastShown = false;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
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
          const message = `同样的时间，你的产出提高了 ${lastCompare.percent}%`;
          setHud((previous) => ({ ...previous, toast: message }));
          if (toastTimer !== null) clearTimeout(toastTimer);
          toastTimer = setTimeout(() => setHud((previous) => ({ ...previous, toast: null })), TOAST_MS);
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

    // event 为空 = 挂载时那一次手动编译；组号是我们的程序化换画布 = 不是玩家编辑。
    const compile = (event?: ChangeEvent): void => {
      const blocks = Blockly.serialization.workspaces.save(workspace) as unknown as WorkspaceJson;
      saved = blocks;
      const result = compileWorkspace(blocks);
      cache = result.program === null ? [] : [result.program];
      // 去重：读档时的编译报错和当前工作区的编译报错常是同一句话，两条一样的红字既吵也会撞 React 的 key
      playErrors = [...new Set([...result.errors, ...hardErrors, ...actionErrors, ...(result.program === null ? [] : runtime.load(result.program))])];
      // 画布内容变了就可能 LOADED ↔ DIRTY（D1：dirty 不落库，每次都重新推导），顺带重算装备的乘数
      refreshBook(event !== undefined && event.group !== PROGRAMMATIC_GROUP);
      setHud((previous) => ({ ...previous, errors: [...playErrors, ...saveErrors] }));
      syncCurve(result.program);
      controller.markDirty();
    };

    workspace.addChangeListener(compile);
    compile();

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
      const key = `${qi}|${state.rate}|${state.stall?.tick ?? -1}|${Math.round(state.demon * 1000)}|${Math.ceil(state.pauseRemainingMs / 100)}|${state.realmName}|${state.threshold}|${state.passivePerSec}|${state.canBreakthrough}|${Math.ceil(state.trialRemainingMs / 100)}|${Math.ceil(state.cooldownRemainingMs / 1000)}|${Math.ceil(state.chargeRemainingMs / 1000)}|${state.chargeReadyAt}|${state.attempt}|${state.insight}|${state.sprintGoalQi}|${Math.floor(state.sprintProgressQi)}|${state.sprintReached}`;
      if (key === lastHudKey) return;
      lastHudKey = key;
      // 突破/渡劫成功之后工具箱跟着换（§4.3）：flyout 是打开时才渲染的，但已打开的面板要当场重建才看得见新块。
      syncToolbox(state.realmIndex);
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
        realm: realmModel(state),
        sprint: sprintModel(state),
        challenge: challengeModel(state),
        toolHint: toolHintOf(state),
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
            // 与 mount 路径共用同一个 setter：转换为 RetreatReport 并更新 HUD
            setHud((previous) => ({
              ...previous,
              retreat: {
                elapsedMs: result.elapsedMs,
                creditedGained: result.creditedGained,
                rawGained: result.rawGained,
                realmName: runtime.state().realmName,
                breakthrough: result.breakthroughs.length > 0
                  ? { realm: result.breakthroughs[0]!.realm, ok: result.breakthroughs[0]!.ok }
                  : null,
              },
            }));
          }
          return result;
        },
      };
    }

    setHud((previous) => {
      // 如果有离线结算报告，转换为 RetreatReport 放入 retreat 字段
      let retreat: RetreatReport | null = null;
      if (offlineReport !== null) {
        retreat = {
          elapsedMs: offlineReport.elapsedMs,
          creditedGained: offlineReport.creditedGained,
          rawGained: offlineReport.rawGained,
          realmName: runtime.state().realmName,
          breakthrough: offlineReport.breakthroughs.length > 0
            ? { realm: offlineReport.breakthroughs[0]!.realm, ok: offlineReport.breakthroughs[0]!.ok }
            : null,
        };
      }
      return {
        ...previous,
        notices: noticeList,
        corrupt: corrupted,
        // 损坏那句在红字里（含备份 key），灰字只标这一次装载的来历，不重复两遍
        save: loaded.fresh ? ['新档 · 尚未落盘'] : ['档已装载'],
        retreat,
      };
    });

    return () => {
      loop.stop();
      if (toastTimer !== null) clearTimeout(toastTimer);
      detachBook();
      detachArtifacts();
      challengeActionRef.current = null;
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

  return (
    <div className="layout">
      <div className="canvas" ref={containerRef} />
      <Hud model={hud} onBookAction={(action) => { bookActionRef.current?.(action); }} onChallenge={() => { challengeActionRef.current?.(); }} onArtifactAction={(id) => { artifactActionRef.current?.(id); }} settings={settings} onSettingsToggle={handleSettingsToggle} onCloseRetreat={handleCloseRetreat} />
    </div>
  );
}
