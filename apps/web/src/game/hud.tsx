import { useState } from 'react';
import type { StallEvent } from '@gongfa/core';

/** 存档损坏：HUD 只显示这一句，逐字段明细收在「详情」里 */
export interface CorruptLineModel {
  readonly line: string;
  readonly detail: readonly string[];
}

export interface HudModel {
  readonly qi: number;
  readonly rate: number;
  readonly errors: readonly string[];
  readonly corrupt: CorruptLineModel | null;
  readonly stall: StallEvent | null;
  /** 存档这条档是怎么来的：加载结果 + 每次落盘回报 */
  readonly save: readonly string[];
  /** 可继续但玩家该知道（回退备用槽、降级空程序），不挡玩法 */
  readonly notices: readonly string[];
}

const STALL_REASON: Record<StallEvent['reason'], string> = {
  budget: '超出本 tick 指令预算',
  loopLimit: '循环嵌套超过上限',
  divZero: '除以零',
};

function CorruptEntry({ model }: { readonly model: CorruptLineModel }) {
  // 默认收起：玩家先要看得见「档还在、已备份」，不是 18 条字段路径
  const [open, setOpen] = useState(false);
  return (
    <li>
      {model.line}
      <button className="details-toggle" type="button" aria-expanded={open} onClick={() => setOpen((previous) => !previous)}>
        {open ? '收起' : '详情'}
      </button>
      {open && <pre className="details">{model.detail.join('\n')}</pre>}
    </li>
  );
}

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
      {(model.errors.length > 0 || model.corrupt !== null) && (
        <ul className="errors">
          {model.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
          {model.corrupt !== null && <CorruptEntry model={model.corrupt} />}
        </ul>
      )}
      {model.save.length > 0 && (
        <ul className="save">
          {model.save.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {model.notices.length > 0 && (
        <ul className="notices">
          {model.notices.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <p className="hint">把工具箱里的积木拖进「每 tick」下面的凹槽：「如果 / 循环」控制产出节奏，「比较」读心魔、存量或预算。</p>
    </aside>
  );
}
