import { useState } from 'react';
import type { BookPhase, StallEvent } from '@gongfa/core';

/** 存档损坏：HUD 只显示这一句，逐字段明细收在「详情」里 */
export interface CorruptLineModel {
  readonly line: string;
  readonly detail: readonly string[];
}

export type BookAction = 'load' | 'freeze' | 'unload' | 'discard';

/** 功法书面板：正文由宿主算好（要读运行时的衰减与心魔乘数），按钮可见性只看相位。 */
export interface BookModel {
  readonly phase: BookPhase;
  readonly text: string;
  /** 目录里有几本装得动的书；0 本时「装载功法书」不该点下去 */
  readonly loadable: number;
}

/** 境界面板（任务 6）：名字、阈值、被动全部来自 realms.json 当前行，HUD 不自己算数。 */
export interface RealmModel {
  readonly name: string;
  readonly threshold: number;
  readonly passivePerSec: number;
  /** 存量 ≥ 阈值且还有下一境 → 按钮可点（渡劫挑战与蓄势在任务 6.5 替换这里） */
  readonly canBreakthrough: boolean;
  /** 走火入魔剩余毫秒：>0 时显示倒计时并禁掉渡劫。惩罚期不落盘（刷新可跳过，见 runtime 的已知漏洞）。 */
  readonly pauseRemainingMs: number;
  readonly demon: number;
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
  readonly book: BookModel;
  readonly realm: RealmModel;
}

const STALL_REASON: Record<StallEvent['reason'], string> = {
  budget: '超出本 tick 指令预算',
  loopLimit: '循环嵌套超过上限',
  divZero: '除以零',
};

// 契约 §6 / D4：DIRTY 不显示「卸下」（要先处理改动），LOADED 与 DIRTY 都给「放弃修改」这条退路。
const BOOK_BUTTONS: Record<BookPhase, readonly { readonly action: BookAction; readonly text: string }[]> = {
  IDLE: [{ action: 'load', text: '装载功法书' }],
  LOADED: [{ action: 'unload', text: '卸下' }, { action: 'discard', text: '放弃修改' }],
  DIRTY: [{ action: 'freeze', text: '固化为个人功法' }, { action: 'discard', text: '放弃修改' }],
  FROZEN: [{ action: 'load', text: '装载功法书' }],
};

function BookPanel({ model, onAction }: { readonly model: BookModel; readonly onAction: (action: BookAction) => void }) {
  return (
    <div className="book">
      <p className="label">功法</p>
      <p className="book-text">{model.text}</p>
      <div className="book-actions">
        {BOOK_BUTTONS[model.phase].map((button) => (
          <button
            key={button.action}
            type="button"
            disabled={button.action === 'load' && model.loadable === 0}
            onClick={() => onAction(button.action)}
          >
            {button.text}
          </button>
        ))}
      </div>
    </div>
  );
}

// 进度条只画比例，数字照样写在文案里：放大镜、纯文本截图、读屏都能拿到同一份数据。
function Bar({ value, of, label, kind }: { readonly value: number; readonly of: number; readonly label: string; readonly kind: 'qi' | 'demon' }) {
  const percent = Math.min(100, Math.max(0, (value / of) * 100));
  return (
    <div className={`bar ${kind}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <div className="bar-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

function RealmPanel({ model, qi, onBreakthrough }: { readonly model: RealmModel; readonly qi: number; readonly onBreakthrough: () => void }) {
  const paused = model.pauseRemainingMs > 0;
  return (
    <div className="realm">
      <p className="label">境界</p>
      <p className="realm-name">{model.name}</p>
      <Bar value={qi} of={model.threshold} label="突破进度" kind="qi" />
      <p className="realm-text">
        存量 {qi} / {model.threshold} · 被动 +{model.passivePerSec}/秒
      </p>
      <button className="breakthrough" type="button" disabled={!model.canBreakthrough || paused} onClick={onBreakthrough}>
        可渡劫
      </button>
      {paused && (
        <p className="backlash">走火入魔：存量 ×0.7、心魔归 0，停 5 秒（刷新可跳过）· 剩余 {(model.pauseRemainingMs / 1000).toFixed(1)} 秒</p>
      )}
      <p className="label">心魔</p>
      <Bar value={model.demon} of={1} label="心魔" kind="demon" />
      <p className="demon-text">{(model.demon * 100).toFixed(1)}%</p>
      <p className="demon-hint">超过 70% 会不时「杂念」，那一 tick 产出减半；涨满 100% 就走火入魔。</p>
    </div>
  );
}

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

export function Hud({ model, onBookAction, onBreakthrough }: { readonly model: HudModel; readonly onBookAction: (action: BookAction) => void; readonly onBreakthrough: () => void }) {
  return (
    <aside className="hud">
      <h1>代码修仙</h1>
      <p className="label">灵力</p>
      <p className="qi">{model.qi}</p>
      <p className="rate">{model.rate.toFixed(1)} / 秒</p>
      <RealmPanel model={model.realm} qi={model.qi} onBreakthrough={onBreakthrough} />
      <BookPanel model={model.book} onAction={onBookAction} />
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
