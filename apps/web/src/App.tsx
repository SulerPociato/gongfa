import { useEffect, useRef, useState } from 'react';
import * as Blockly from 'blockly';
import * as zhHans from 'blockly/msg/zh-hans';
import {
  BLOCK_DEFINITIONS,
  compileWorkspace,
  GONGFA_THEME,
  STARTER_WORKSPACE_JSON,
  TOOLBOX_JSON,
  type WorkspaceJson,
} from '@gongfa/blocks';
import { createRuntime, type Runtime } from './game/runtime';
import { createLoop } from './game/loop';
import { Hud, type HudModel } from './game/hud';

type InjectOptions = NonNullable<Parameters<typeof Blockly.inject>[1]>;
type ThemeConfig = Parameters<typeof Blockly.Theme.defineTheme>[1];
type SerializedState = Parameters<typeof Blockly.serialization.workspaces.load>[0];

// 块定义与语言包是 Blockly 的进程级单例：放模块顶层只执行一次，
// 放 useEffect 里会被 StrictMode 的双挂载二次注册（Blockly 对重复 type 直接报错）。
Blockly.setLocale(zhHans as unknown as Parameters<typeof Blockly.setLocale>[0]);
Blockly.defineBlocksWithJsonArray(BLOCK_DEFINITIONS as unknown as Parameters<typeof Blockly.defineBlocksWithJsonArray>[0]);

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  if (runtimeRef.current === null) runtimeRef.current = createRuntime();
  const [hud, setHud] = useState<HudModel>({ qi: 0, rate: 0, errors: [] });

  useEffect(() => {
    const container = containerRef.current;
    const runtime = runtimeRef.current;
    if (container === null || runtime === null) return;

    const workspace = Blockly.inject(container, {
      theme: Blockly.Theme.defineTheme(GONGFA_THEME.name, GONGFA_THEME as unknown as ThemeConfig),
      toolbox: TOOLBOX_JSON as unknown as NonNullable<InjectOptions['toolbox']>,
    });
    // 开局只预置入口块；无存档，刷新回到这个状态（任务 4 才接 SaveFile）。
    Blockly.serialization.workspaces.load(STARTER_WORKSPACE_JSON as unknown as SerializedState, workspace);

    const compile = (): void => {
      const saved = Blockly.serialization.workspaces.save(workspace) as unknown as WorkspaceJson;
      const result = compileWorkspace(saved);
      const errors = [...result.errors];
      if (result.program !== null) errors.push(...runtime.load(result.program));
      setHud((previous) => ({ ...previous, errors }));
    };

    workspace.addChangeListener(compile);
    compile();

    const loop = createLoop(runtime, (state) => {
      const qi = Math.floor(state.qi);
      setHud((previous) =>
        previous.qi === qi && previous.rate === state.ratePerSec ? previous : { qi, rate: state.ratePerSec, errors: previous.errors }
      );
    });
    loop.start();

    return () => {
      loop.stop();
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
