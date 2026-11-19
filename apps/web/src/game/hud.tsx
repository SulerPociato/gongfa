import { useState } from 'react';
import { AUTO_RATE, CHALLENGE_TRIAL_MS, FAILURE_QI_MULT, GUARANTEE_ATTEMPT, MANUAL_RATE, type BookPhase, type StallEvent } from '@gongfa/core';

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
  /** 存量 ≥ 阈值且还有下一境（蓄势另算，见 ChallengeModel）。任务 6 的简化路径仍然看它。 */
  readonly canBreakthrough: boolean;
  /** 走火入魔剩余毫秒：>0 时显示倒计时并禁掉渡劫。惩罚期不落盘（刷新可跳过，见 runtime 的已知漏洞）。 */
  readonly pauseRemainingMs: number;
  readonly demon: number;
}

/**
 * 渡劫面板（任务 6.5）：phase 由宿主从 runtime 的字段推出来，HUD 只按相位选文案。
 * threshold = 存量还没达标；charge = 达标了但蓄势没到点；cooldown = 上次渡劫的 60 秒；
 * ready = 能点；trial = 10 秒进行中；final = 元婴，无劫可渡。
 */
export type ChallengePhase = 'threshold' | 'charge' | 'cooldown' | 'ready' | 'trial' | 'final';

export interface ChallengeModel {
  readonly phase: ChallengePhase;
  /** 按钮的 disabled 只看这一条：phase 只决定说哪句话。 */
  readonly enabled: boolean;
  readonly nextRealmName: string | null;
  readonly chargeRemainingMs: number;
  readonly trialRemainingMs: number;
  readonly cooldownRemainingMs: number;
  /** 下一次冲关是本境界第几次（§7.1 的 N，从 1 起）；连续失败次数 = N - 1。 */
  readonly attempt: number;
  readonly insight: number;
  readonly demo: boolean;
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
  /** 渡劫面板（任务 6.5）：按钮相位、10 秒倒计时、保底与悟道全由 runtime 算好交过来。 */
  readonly challenge: ChallengeModel;
  /** 工具箱这一栏给到哪一境（契约 §4.3 门控的可观察面）：文案由宿主按境界算好，HUD 不判断。 */
  readonly toolHint: string;
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

function RealmPanel({ model, qi }: { readonly model: RealmModel; readonly qi: number }) {
  const paused = model.pauseRemainingMs > 0;
  return (
    <div className="realm">
      <p className="label">境界</p>
      <p className="realm-name">{model.name}</p>
      <Bar value={qi} of={model.threshold} label="突破进度" kind="qi" />
      <p className="realm-text">
        存量 {qi} / {model.threshold} · 被动 +{model.passivePerSec}/秒
      </p>
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

// 按钮文案按相位给，六态互斥：HUD 不做任何比较运算，phase 是宿主从 runtime 字段推出来的。
const BUTTON_TEXT: Record<ChallengePhase, string> = {
  threshold: '先攒存量',
  charge: '蓄势中',
  cooldown: '冷却中',
  ready: '可渡劫',
  trial: '立即冲关',
  final: '已至末境',
};

// mm:ss：15 / 60 分钟的蓄势用分秒，不用「900 秒」让玩家自己除。
// 名字带 remain：App.tsx 另有一个把 epoch 毫秒印成 HH:MM:SS 的 clockText，两者口径不同。
function remainText(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function ChallengePanel({ model, onPress }: { readonly model: ChallengeModel; readonly onPress: () => void }) {
  const sub =
    model.phase === 'charge' ? `还需 ${remainText(model.chargeRemainingMs)}`
      : model.phase === 'cooldown' ? `还剩 ${(model.cooldownRemainingMs / 1000).toFixed(1)} 秒`
        : model.phase === 'trial' ? `剩余 ${(model.trialRemainingMs / 1000).toFixed(1)} 秒`
          : model.phase === 'ready' && model.nextRealmName !== null ? `→ ${model.nextRealmName}`
            : '';
  return (
    <div className="challenge">
      <button className="challenge-button" type="button" disabled={!model.enabled} onClick={onPress}>
        {BUTTON_TEXT[model.phase]}
        {sub === '' ? '' : ` ${sub}`}
      </button>
      {model.phase === 'trial' && (
        <div className="trial">
          {/* 01-design §4.4 的「限时改功法」：改的是产出，不是概率 —— 这句必须写死，不然玩家会以为磨得越久越容易。 */}
          <p className="trial-rule">改功法只改接下来的产出，不改成功率。</p>
          <p className="trial-odds">
            {(CHALLENGE_TRIAL_MS / 1000).toFixed(0)} 秒内点「立即冲关」= 手动 {(MANUAL_RATE * 100).toFixed(0)}% ／ 放手不管 = 托管 {(AUTO_RATE * 100).toFixed(0)}%
          </p>
        </div>
      )}
      {/* 保底与冷却都在内存里（§5.1 没这两个字段）：文案必须写明刷新清零，否则玩家以为攒到了第 2 次。 */}
      <p className="challenge-meta">
        本档连续失败 {model.attempt - 1} 次（刷新清零）· 第 {model.attempt} 次冲关{model.attempt >= GUARANTEE_ATTEMPT ? '（保底必成）' : ''} ·
        失败存量 ×{FAILURE_QI_MULT} · 悟道 {model.insight}（本档）
      </p>
      {model.demo && <p className="demo-badge">演示模式：跳过蓄势与 10 秒渡劫</p>}
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

export function Hud({ model, onBookAction, onChallenge }: { readonly model: HudModel; readonly onBookAction: (action: BookAction) => void; readonly onChallenge: () => void }) {
  return (
    <aside className="hud">
      <h1>代码修仙</h1>
      <p className="label">灵力</p>
      <p className="qi">{model.qi}</p>
      <p className="rate">{model.rate.toFixed(1)} / 秒</p>
      <RealmPanel model={model.realm} qi={model.qi} />
      <ChallengePanel model={model.challenge} onPress={onChallenge} />
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
      {/* 工具箱被境界挡住几块要说出来，否则玩家以为游戏只有四块积木（§4.3 的门控是内容设计，不是缺件）。 */}
      <p className="tool-hint">{model.toolHint}</p>
    </aside>
  );
}
