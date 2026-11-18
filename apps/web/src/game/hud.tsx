import type { StallEvent } from '@gongfa/core';

export interface HudModel {
  readonly qi: number;
  readonly rate: number;
  readonly errors: readonly string[];
  readonly stall: StallEvent | null;
}

const STALL_REASON: Record<StallEvent['reason'], string> = {
  budget: '超出本 tick 指令预算',
  loopLimit: '循环嵌套超过上限',
  divZero: '除以零',
};

export function Hud({ model }: { readonly model: HudModel }) {
  return (
    <aside className="hud">
      <h1>代码修仙</h1>
      <p className="label">灵力</p>
      <p className="qi">{model.qi}</p>
      <p className="rate">{model.rate.toFixed(1)} / 秒</p>
      {model.stall !== null && (
        <p className="stall">
          第 {model.stall.steps} 步没跑完（{STALL_REASON[model.stall.reason]}，停在第 {model.stall.pc + 1} 条指令，tick {model.stall.tick}）
        </p>
      )}
      {model.errors.length > 0 && (
        <ul className="errors">
          {model.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <p className="hint">把工具箱里的积木拖进「每 tick」下面的凹槽：「如果 / 循环」控制产出节奏，「比较」读心魔、存量或预算。</p>
    </aside>
  );
}
