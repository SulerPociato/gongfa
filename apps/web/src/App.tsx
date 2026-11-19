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
import { loadGame, newGameState, type GameState, type LoadResult, type Program, type SaveStorage } from '@gongfa/core';
import { createLocalStorageSaveStorage, wallClock } from './adapters/storage';
import { randomSeed } from './adapters/seed';
import { createSaveController, type SaveSnapshot } from './game/save';
import { createRuntime, type Runtime } from './game/runtime';
import { createLoop } from './game/loop';
import { Hud, type CorruptLineModel, type HudModel } from './game/hud';

type InjectOptions = NonNullable<Parameters<typeof Blockly.inject>[1]>;
type ThemeConfig = Parameters<typeof Blockly.Theme.defineTheme>[1];
type SerializedState = Parameters<typeof Blockly.serialization.workspaces.load>[0];
type SaveBridge = ReturnType<typeof createSaveController>;

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
  if (runtimeRef.current === null) runtimeRef.current = createRuntime();
  const [hud, setHud] = useState<HudModel>({ qi: 0, rate: 0, errors: [], corrupt: null, stall: null, save: ['读取存档…'], notices: [] });

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
        workspace.clear();
        Blockly.serialization.workspaces.load(state as SerializedState, workspace);
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
    const hardErrors = [...blockErrors, ...restoreErrors, ...archiveErrors];
    const base: GameState = loaded.state ?? newGameState({ seed: randomSeed(), workspace: saved ?? STARTER_WORKSPACE_JSON, now: wallClock.now() });
    // 红字分两路：playErrors = 程序/存档本身没跑起来，saveErrors = 落盘失败（超限、配额满）。
    // 落盘失败必须显眼：玩家以为存上了、其实没存，比编译报错更能坑人。
    let playErrors: string[] = [...hardErrors];
    let saveErrors: string[] = [];
    const controller = createSaveController({
      storage,
      clock: wallClock,
      base,
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

    const compile = (): void => {
      const blocks = Blockly.serialization.workspaces.save(workspace) as unknown as WorkspaceJson;
      saved = blocks;
      const result = compileWorkspace(blocks);
      cache = result.program === null ? [] : [result.program];
      // 去重：读档时的编译报错和当前工作区的编译报错常是同一句话，两条一样的红字既吵也会撞 React 的 key
      playErrors = [...new Set([...result.errors, ...hardErrors, ...(result.program === null ? [] : runtime.load(result.program))])];
      setHud((previous) => ({ ...previous, errors: [...playErrors, ...saveErrors] }));
      controller.markDirty();
    };

    workspace.addChangeListener(compile);
    compile();

    const loop = createLoop(runtime, (state) => {
      const qi = Math.floor(state.qi);
      setHud((previous) =>
        previous.qi === qi && previous.rate === state.rate && previous.stall === state.stall
          ? previous
          : { qi, rate: state.rate, errors: previous.errors, corrupt: previous.corrupt, stall: state.stall, save: previous.save, notices: previous.notices }
      );
    });
    loop.start();

    setHud((previous) => ({
      ...previous,
      notices: loaded.notices,
      corrupt: corrupted,
      // 损坏那句在红字里（含备份 key），灰字只标这一次装载的来历，不重复两遍
      save: loaded.fresh ? ['新档 · 尚未落盘'] : ['档已装载'],
    }));

    return () => {
      loop.stop();
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
      <Hud model={hud} />
    </div>
  );
}
