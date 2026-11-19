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
  TOOLBOX_JSON,
  type WorkspaceJson,
} from '@gongfa/blocks';
import { bookEvent, derivePhase, loadGame, newGameState, type BookDef, type BookEvent, type BookPhase, type GameState, type LoadResult, type Program, type SaveStorage } from '@gongfa/core';
import { createLocalStorageSaveStorage, wallClock } from './adapters/storage';
import { randomSeed } from './adapters/seed';
import { createSaveController, type SaveSnapshot } from './game/save';
import { createRuntime, type Runtime, type RuntimeState } from './game/runtime';
import { createLoop } from './game/loop';
import { BOOK_CATALOGUE, STARTER_BOOK_ID, bookById, grantStarterBook } from './game/books';
import { Hud, type BookAction, type CorruptLineModel, type HudModel, type RealmModel } from './game/hud';

type InjectOptions = NonNullable<Parameters<typeof Blockly.inject>[1]>;
type ThemeConfig = Parameters<typeof Blockly.Theme.defineTheme>[1];
type SerializedState = Parameters<typeof Blockly.serialization.workspaces.load>[0];
type SaveBridge = ReturnType<typeof createSaveController>;

// D5：验收与回放用的只读句柄（state() 的实时视图，含 noiseTicks / backlashTicks / tick）。
// 只在 DEV 或 ?debug=1 时挂，正式构建默认不挂；卸载时删掉，不留上一份会话的 runtime。
declare global {
  interface Window {
    __gongfa_debug?: { readonly state: () => RuntimeState } | undefined;
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
  const breakthroughActionRef = useRef<(() => void) | null>(null);
  if (runtimeRef.current === null) runtimeRef.current = createRuntime();
  const booted = runtimeRef.current.state();
  const [hud, setHud] = useState<HudModel>({ qi: 0, rate: 0, errors: [], corrupt: null, stall: null, save: ['读取存档…'], notices: [], book: { phase: 'IDLE', text: '未装载功法 · 心魔 ×1.00', loadable: 0 }, realm: realmModel(booted) });

  useEffect(() => {
    const container = containerRef.current;
    const runtime = runtimeRef.current;
    if (container === null || runtime === null) return;

    const storage = createLocalStorageSaveStorage();
    const workspace = Blockly.inject(container, {
      theme: Blockly.Theme.defineTheme(GONGFA_THEME.name, GONGFA_THEME as unknown as ThemeConfig),
      toolbox: TOOLBOX_JSON as unknown as NonNullable<InjectOptions['toolbox']>,
    });

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
        // 任务 5B：持有与装备随时会被四个按钮改写，必须跟着快照走，不能只靠基线带
        ownedBooks: game.ownedBooks,
        equippedBook: game.equippedBook,
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
    const hardErrors = [...BOOK_CATALOGUE.errors, ...blockErrors, ...restoreErrors, ...archiveErrors];
    // 装备与持有是 GameState 的字段，也是玩家随时会改的东西，所以前台拿一份可变的档面走：
    // 装载/卸下/固化改写它，落盘由 snapshot 带出去，读写两端各校验一次（契约 §5.2）。
    // 新档直接带开局书（D3）；5A 落盘的旧档里 ownedBooks 是空的，靠 grantStarterBook 当场补发一次。
    let game: GameState = loaded.state ?? newGameState({ seed: randomSeed(), workspace: saved ?? STARTER_WORKSPACE_JSON, now: wallClock.now(), ownedBooks: [STARTER_BOOK_ID] });
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

    // 任务 6 的简化突破：存量达标就进下一境（qi=0、demon=0，契约 §7.1），本轮没有渡劫挑战。
    // 境界一变，书的衰减要按新境界重算，所以成功后走一次 refreshBook：sink 与 HUD 的「衰减 ×」同时跟上。
    breakthroughActionRef.current = (): void => {
      const errors = runtime.breakthrough();
      if (errors.length > 0) {
        pushActionErrors(errors);
        return;
      }
      refreshBook(false);
      pushNotice(`突破成功：进入${runtime.state().realmName}，存量与心魔清零`);
      controller.markDirty();
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
      controller.markDirty();
    };

    workspace.addChangeListener(compile);
    compile();

    // 境界/心魔/惩罚倒计时是连续变化的，逐帧比上一次贵；这些字段量化后拼成 key，
    // 只有真正看得出来的变化（灵力整数、速率、心魔千分位、剩余 0.1 秒、境界四件套、stall）才重渲染。
    let lastHudKey = '';
    const loop = createLoop(runtime, (state) => {
      const qi = Math.floor(state.qi);
      const key = `${qi}|${state.rate}|${state.stall?.tick ?? -1}|${Math.round(state.demon * 1000)}|${Math.ceil(state.pauseRemainingMs / 100)}|${state.realmName}|${state.threshold}|${state.passivePerSec}|${state.canBreakthrough}`;
      if (key === lastHudKey) return;
      lastHudKey = key;
      setHud((previous) => ({ ...previous, qi, rate: state.rate, stall: state.stall, realm: realmModel(state) }));
    });
    loop.start();

    // D5：只读调试句柄。Vite 的类型入口没进本项目的 tsconfig types，所以显式取一次 import.meta.env：
    // 构建时它会被换成字面量对象，正式构建里 DEV 就是 false，默认不挂；验收用 ?debug=1 打开。
    const debugVisible = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true
      || new URLSearchParams(window.location.search).has('debug');
    if (debugVisible) window.__gongfa_debug = { state: () => runtime.state() };

    setHud((previous) => ({
      ...previous,
      notices: noticeList,
      corrupt: corrupted,
      // 损坏那句在红字里（含备份 key），灰字只标这一次装载的来历，不重复两遍
      save: loaded.fresh ? ['新档 · 尚未落盘'] : ['档已装载'],
    }));

    return () => {
      loop.stop();
      detachBook();
      breakthroughActionRef.current = null;
      if (debugVisible) delete window.__gongfa_debug;
      // StrictMode 的双挂载与真实卸载都走这里：先落一次档再拆工作区，别把刚搭的程序丢在内存里
      controller.flush();
      detachSave();
      saveRef.current = null;
      workspace.dispose();
    };
  }, []);

  return (
    <div className="layout">
      <div className="canvas" ref={containerRef} />
      <Hud model={hud} onBookAction={(action) => { bookActionRef.current?.(action); }} onBreakthrough={() => { breakthroughActionRef.current?.(); }} />
    </div>
  );
}
