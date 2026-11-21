import { useEffect, useRef, useState } from 'react';
import { AUTO_RATE, CHALLENGE_TRIAL_MS, FAILURE_QI_MULT, GUARANTEE_ATTEMPT, MANUAL_RATE, type BookPhase, type StallEvent } from '@gongfa/core';
import { compareParts } from './format';
import type { TutorialBarModel } from './tutorial';

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

/**
 * 道具面板（任务 7A，契约 §2.4）：一行一件，按钮只管装备/卸下。
 * name 与 effect 都由宿主从 content/artifacts.json 拼出来，HUD 不写死数值——
 * 表改成 ×0.6 而面板还写着 ×0.7 就是第二份口径。
 */
export interface ArtifactRow {
  readonly id: string;
  readonly name: string;
  readonly effect: string;
  readonly equipped: boolean;
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
  /**
   * 心魔条旁的常驻提示（任务 8 P0-C 第 6 项），例如「调息 -0.0005/次」。
   * 数值由宿主从 actions.json 拼好交进来，HUD 不查表也不格式化；null = 表里没有调息，整句不显示。
   */
  readonly calmText: string | null;
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
}

export interface RetreatReport {
  readonly elapsedMs: number;
  readonly creditedGained: number;
  readonly rawGained: number;
  readonly realmName: string;
  readonly breakthrough: { readonly realm: number; readonly ok: boolean } | null;
}

/**
 * 试炼面板（任务 8，契约 §7.1.1）：本境界 60 秒滑动窗口的产出进度。
 * 四个数全部由 runtime 算好：HUD 只画进度、选文案，不做「还差多少」「减半成几秒」这类算术。
 */
export interface SprintModel {
  /** 目标产出；null = 表里没有这一境，整行不显示（画一条 /0 的假进度比不画更糟）。 */
  readonly goalQi: number | null;
  readonly progressQi: number;
  /** 窗口长度毫秒：文案里的「60 秒」从这里除，不写死。 */
  readonly windowMs: number;
  /** 本境界是否已拿到减半：只生效一次、不可叠加，所以达成后要换成完成态文案。 */
  readonly reached: boolean;
}

/**
 * 曲线预览（任务 8 P0-B）：60 秒累计产出的折线、阈值参考线、预计达标秒数与变更对比行。
 * 点、阈值、秒数、百分比全部由 core 的简化模型（previewCurve）算好 —— HUD 只做像素映射和选文案，
 * 一次除法都不做，否则「面板说的」和「游戏给的」迟早分成两套口径。
 */
export interface CurveCompare {
  readonly fromPerSec: number;
  readonly toPerSec: number;
  /** 相对变化的整数百分比（可负）：宿主算好，HUD 不拿两个小数自己除。 */
  readonly percent: number;
}

export interface CurveModel {
  /** 60 个累计点；空数组 = 没有可预览的程序（编译失败或凹槽空着），整块面板不出现。 */
  readonly points: readonly number[];
  readonly threshold: number;
  /** null = 这份程序一产出都没有。 */
  readonly etaSec: number | null;
  /** 60 秒窗口内够不够到阈值：不够就补一句「超出本图」，别让参考线看着像够不着的 bug。 */
  readonly reachesInWindow: boolean;
  /** 窗口秒数：横轴文案从这里除，不写死 60。 */
  readonly seconds: number;
  readonly compare: CurveCompare | null;
  /** 指令预算截断：曲线只描述这一 tick 跑得完的部分。 */
  readonly truncated: boolean;
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
  /** 道具面板（任务 7A）：目录读不起来时宿主给空数组，红字里已经有那句原因。 */
  readonly artifacts: readonly ArtifactRow[];
  readonly realm: RealmModel;
  /** 曲线预览（任务 8）：紧贴境界面板，因为它俩说的是同一件事 —— 这条程序离阈值多远。 */
  readonly curve: CurveModel;
  /** 试炼（任务 8）：紧挨渡劫面板，因为它的唯一后果就是「蓄势减半」。 */
  readonly sprint: SprintModel;
  /** 渡劫面板（任务 6.5）：按钮相位、10 秒倒计时、保底与悟道全由 runtime 算好交过来。 */
  readonly challenge: ChallengeModel;
  /** 工具箱这一栏给到哪一境（契约 §4.3 门控的可观察面）：文案由宿主按境界算好，HUD 不判断。 */
  readonly toolHint: string;
  /** 闭关报告（任务 7B）：离线结算后显示，玩家点「知道了」关闭 */
  readonly retreat: RetreatReport | null;
  /** 变更提示（任务 8）：产出第一次显著跳涨时弹一次，文案由宿主拼好，超时清除也归宿主。 */
  readonly toast: string | null;
  /** 手把手引导的底部条（任务 8 P0-D）：null = 引导没启动或已永久关闭。 */
  readonly tutorial: TutorialBarModel | null;
  /** ?demo=1：左上角常驻角标，以及渡劫面板要说「当场按 85% 结算」。整份模型只有这一个演示开关。 */
  readonly demo: boolean;
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

// 装备状态用 aria-pressed 表达：读屏和截图都能拿到「这件现在生效」，不靠按钮变色暗示。
function ArtifactPanel({ rows, onToggle }: { readonly rows: readonly ArtifactRow[]; readonly onToggle: (id: string) => void }) {
  return (
    <div className="artifacts">
      {rows.map((row) => (
        <div className="artifact" key={row.id}>
          <button className="artifact-toggle" type="button" aria-pressed={row.equipped} onClick={() => onToggle(row.id)}>
            {row.equipped ? `卸下${row.name}` : `装备${row.name}`}
          </button>
          <p className="artifact-effect">{row.effect}</p>
        </div>
      ))}
    </div>
  );
}

// 功法与道具合并卡片（B3 续）：第一行功法，第二行道具
function BookArtifactPanel({ bookModel, artifactRows, onBookAction, onArtifactToggle }: {
  readonly bookModel: BookModel;
  readonly artifactRows: readonly ArtifactRow[];
  readonly onBookAction: (action: BookAction) => void;
  readonly onArtifactToggle: (id: string) => void;
}) {
  return (
    <div className="book-artifacts">
      <p className="label">功法与道具</p>
      <div className="book-artifact-row">
        <BookPanel model={bookModel} onAction={onBookAction} />
      </div>
      {artifactRows.length > 0 && (
        <div className="book-artifact-row">
          <ArtifactPanel rows={artifactRows} onToggle={onArtifactToggle} />
        </div>
      )}
    </div>
  );
}

// 进度条只画比例，数字照样写在文案里：放大镜、纯文本截图、读屏都能拿到同一份数据。
function Bar({ value, of, label, kind }: { readonly value: number; readonly of: number; readonly label: string; readonly kind: 'qi' | 'demon' | 'sprint' }) {
  const percent = Math.min(100, Math.max(0, (value / of) * 100));
  return (
    <div className={`bar ${kind}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <div className="bar-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

// 折线画布的像素尺寸：viewBox 与之一致，宽度交给 CSS（HUD 是窄栏，SVG 用 preserveAspectRatio 缩放）。
const CURVE_W = 300;
const CURVE_H = 120;

// 曲线面板（任务 8 P0-B）：拖一块积木就能看见「这么改值多少」，不用等 100 秒验证猜想。
// 模型只算无干扰产出，所以那句免责必须常驻：拿估算当承诺是这轮要修的「一直在等」的反面教材。
function CurvePanel({ model }: { readonly model: CurveModel }) {
  if (model.points.length === 0) return null;
  const last = model.points[model.points.length - 1] ?? 0;
  // 纵轴上限取「曲线末点与阈值的大者」：阈值那条线永远画在图里，玩家才看得见自己差多远。
  const top = Math.max(last, model.threshold, 1);
  const x = (index: number): number => (model.points.length === 1 ? CURVE_W : (index / (model.points.length - 1)) * CURVE_W);
  const y = (value: number): number => CURVE_H - (value / top) * CURVE_H;
  const line = model.points.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  // 渐变填充区域：从曲线到 SVG 底部
  const area = `0,${CURVE_H} ${line} ${CURVE_W},${CURVE_H}`;
  const eta = model.etaSec === null
    ? `${model.seconds} 秒内不产出灵力`
    : `预计 ${model.etaSec} 秒达标${model.reachesInWindow ? '' : `（超出本图 ${model.seconds} 秒）`}`;
  // 三个数字的写法与引导第 4 步共用 compareParts：两处各写一遍 toFixed，早晚会分叉成两个「每秒」。
  const compare = model.compare === null ? null : compareParts(model.compare.fromPerSec, model.compare.toPerSec, model.compare.percent);
  return (
    <div className="curve">
      <p className="label">产出曲线</p>
      <svg className="curve-svg" viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} preserveAspectRatio="none" role="img"
        aria-label={`60 秒产出曲线，末点 ${Math.round(last)}，阈值 ${model.threshold}，${eta}`}>
        <defs>
          <linearGradient id="curveGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(53, 224, 200, 0.18)" />
            <stop offset="100%" stopColor="rgba(53, 224, 200, 0)" />
          </linearGradient>
        </defs>
        <polygon className="curve-area" points={area} />
        <line className="curve-threshold-line" x1="0" y1={y(model.threshold).toFixed(1)} x2={CURVE_W} y2={y(model.threshold).toFixed(1)} />
        <polyline className="curve-line" points={line} />
        {/* 横轴标签 */}
        <text x="0" y={CURVE_H - 4} fill="rgba(255,255,255,0.5)" fontSize="10" fontFamily="JetBrains Mono, monospace">0</text>
        <text x={CURVE_W / 2} y={CURVE_H - 4} fill="rgba(255,255,255,0.5)" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">30</text>
        <text x={CURVE_W} y={CURVE_H - 4} fill="rgba(255,255,255,0.5)" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">60</text>
      </svg>
      <p className="curve-eta">{eta}</p>
      {compare !== null && <p className="curve-compare">产出 {compare.from} → {compare.to} / 秒（{compare.percent}%）</p>}
      {model.truncated && <p className="curve-truncated">程序超出本 tick 指令预算，曲线只算跑得完的部分</p>}
      <p className="curve-note">直线执行估算，未计入「如果」分支与心魔折扣</p>
    </div>
  );
}

function RealmPanel({ model, qi }: { readonly model: RealmModel; readonly qi: number }) {
  const paused = model.pauseRemainingMs > 0;
  return (
    <div className="realm">
      <p className="label">境界</p>
      <div className="realm-header">
        <p className="realm-name">{model.name}</p>
        <p className="realm-stock">存量 {qi} / {model.threshold}</p>
      </div>
      <Bar value={qi} of={model.threshold} label="突破进度" kind="qi" />
      {paused && (
        <p className="backlash">走火入魔：存量 ×0.7、心魔归 0，停 5 秒（刷新可跳过）· 剩余 {(model.pauseRemainingMs / 1000).toFixed(1)} 秒</p>
      )}
      {/* 心魔这一小截单独成组：引导第 5 步只点亮它，不点亮整块境界面板。 */}
      <div className="realm-demon tut-target">
        <div className="demon-row">
          <p className="demon-label">心魔</p>
          <Bar value={model.demon} of={1} label="心魔" kind="demon" />
          <p className="demon-text">
            {(model.demon * 100).toFixed(1)}%
            {model.calmText !== null && <span className="demon-calm"> {model.calmText}</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

// 试炼（契约 §7.1.1）：一句常驻文案 + 一条实时进度。秒数从 windowMs 除出来，
// 目标由 runtime 从表里给 —— 面板不自己写 480，否则表改了这里就是第二份口径。
// 只有一种完成态（reached），因为「减半」这件事不可叠加，玩家不需要知道第二次。
// 达成态故意不写「已减半」：炼气→筑基 的窗口本来就是 0（§7.3），那一境没有东西可减，说了就是假话。
function SprintPanel({ model }: { readonly model: SprintModel }) {
  if (model.goalQi === null) return null;
  const seconds = (model.windowMs / 1000).toFixed(0);
  return (
    <div className={`sprint${model.reached ? ' is-reached' : ''}`}>
      <p className="label">试炼</p>
      <div className="sprint-header">
        <Bar value={model.progressQi} of={model.goalQi} label="试炼进度" kind="sprint" />
        <p className="sprint-progress">{Math.floor(model.progressQi)} / {model.goalQi}</p>
      </div>
      <p className="sprint-text">{seconds} 秒内达成可减半蓄势</p>
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

// mm:ss：2 / 5 分钟的蓄势用分秒，不用「120 秒」让玩家自己除。
// 名字带 remain：App.tsx 另有一个把 epoch 毫秒印成 HH:MM:SS 的 clockText，两者口径不同。
function remainText(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function ChallengePanel({ model, demo, onPress }: { readonly model: ChallengeModel; readonly demo: boolean; readonly onPress: () => void }) {
  const sub =
    model.phase === 'charge' ? `还需 ${remainText(model.chargeRemainingMs)}`
      : model.phase === 'cooldown' ? `还剩 ${(model.cooldownRemainingMs / 1000).toFixed(1)} 秒`
        : model.phase === 'trial' ? `剩余 ${(model.trialRemainingMs / 1000).toFixed(1)} 秒`
          : model.phase === 'ready' && model.nextRealmName !== null ? `→ ${model.nextRealmName}`
            : '';
  return (
    <div className="challenge">
      {/* is-ready：首次「可渡劫」的脉冲动画挂在这上面（P0-C 第 4 项），只看相位，不看别的。 */}
      <button className={`challenge-button${model.phase === 'ready' ? ' is-ready' : ''} tut-target`} type="button" disabled={!model.enabled} onClick={onPress}>
        {BUTTON_TEXT[model.phase]}
        {sub === '' ? '' : ` ${sub}`}
      </button>
      {model.phase === 'trial' && (
        <div className="trial">
          {/* 命名（任务 8）：10 秒这一格叫「渡劫挑战」，60 秒那一格叫「试炼」——同一屏两个「试炼」玩家会分不清在等哪个。 */}
          <p className="trial-title">渡劫挑战</p>
          {/* 裁定 1：这句只在 10 秒窗口里出现。它是「你不用慌」的即时安慰，常驻在按钮下面就成了废话。
              不操作不是惩罚而是 60% 的托管档，这句不写死玩家就会以为磨时间能磨出更高概率。 */}
          <p className="trial-first">
            {(CHALLENGE_TRIAL_MS / 1000).toFixed(0)} 秒内不操作，自动按 {(AUTO_RATE * 100).toFixed(0)}% 结算（无需操作，不额外扣代价）
          </p>
          {/* 01-design §4.4 的「限时改功法」：改的是产出，不是概率 —— 这句必须写死，不然玩家会以为磨得越久越容易。 */}
          <p className="trial-rule">改功法只改接下来的产出，不改成功率。</p>
          <p className="trial-odds">
            {(CHALLENGE_TRIAL_MS / 1000).toFixed(0)} 秒内点「立即冲关」= 手动 {(MANUAL_RATE * 100).toFixed(0)}% ／ 放手不管 = 托管 {(AUTO_RATE * 100).toFixed(0)}%
          </p>
        </div>
      )}
      {/* 演示模式根本没有 10 秒窗口（runtime 里 pressChallenge 直接按手动口径结算），
          上面那一整块在演示下永远不出现 —— 于是这里补一句常驻的：按钮按下去会发生什么，
          得有人说明白，否则「点一下就成了」看着像 bug。百分比同样从 MANUAL_RATE 拼。 */}
      {demo && model.phase !== 'trial' && (
        <div className="trial">
          <p className="trial-first">演示模式：点「可渡劫」当场按 {(MANUAL_RATE * 100).toFixed(0)}% 结算</p>
        </div>
      )}
      {/* 保底与冷却都在内存里（§5.1 没这两个字段）：文案必须写明刷新清零，否则玩家以为攒到了第 2 次。 */}
      <p className="challenge-meta">
        本档连续失败 {model.attempt - 1} 次（刷新清零）· 第 {model.attempt} 次冲关{model.attempt >= GUARANTEE_ATTEMPT ? '（保底必成）' : ''} ·
        失败存量 ×{FAILURE_QI_MULT} · 悟道 {model.insight}（本档）
      </p>
    </div>
  );
}

// 闭关报告面板（任务 7B）：离线结算后显示，玩家点「知道了」关闭
function RetreatPanel({ report, onClose }: { readonly report: RetreatReport; readonly onClose: () => void }) {
  const durationMin = Math.floor(report.elapsedMs / 60000);
  const durationSec = Math.floor((report.elapsedMs % 60000) / 1000);
  return (
    <div className="retreat">
      <p className="retreat-title">闭关报告</p>
      <p className="retreat-line">闭关 {durationMin}分{durationSec}秒 ｜ 灵力 +{Math.floor(report.creditedGained)}（离线效率 60%）</p>
      <p className="retreat-line">同期在线口径约 +{Math.floor(report.rawGained)}（未扣心魔、杂念与走火损失）</p>
      <p className="retreat-line">当前境界：{report.realmName}</p>
      {report.breakthrough !== null && (
        <p className={`retreat-breakthrough ${report.breakthrough.ok ? '' : 'failed'}`}>
          {report.breakthrough.ok ? `渡劫成功：进入${report.realmName}` : '渡劫失败：停在阈值'}
        </p>
      )}
      <p className="retreat-note">离线期间心魔不增长，杂念与走火入魔不生效。</p>
      <button className="retreat-close" type="button" onClick={onClose}>
        知道了
      </button>
    </div>
  );
}

// 底部引导条（任务 8 P0-D）：文案 + 「n/6」 + 跳过，三个东西一行装完。
// 裁定 2：跳过只在这条右端出现一个入口，右上角不再放第二个 —— 两个入口玩家会按错。
// 结束态（step === null）只剩文案：没有下一步可跳，按钮留着就是死键。
// 需求变更 2026-11-21：气泡能贴到目标上时，这条降级成「迷你进度」，只报 n/6 和跳过；
// 贴不上（目标没渲染、工具箱收起）才把完整文案放回这里 —— 引导的话永远有一个地方说得出。
export function TutorialBar({ model, mini, onSkip }: { readonly model: TutorialBarModel; readonly mini: boolean; readonly onSkip: () => void }) {
  return (
    <div className={`tutorial-bar${mini ? ' is-mini' : ''}`} role={mini ? undefined : 'status'}>
      {!mini && <p className="tutorial-text">{model.text}</p>}
      {model.step !== null && <p className="tutorial-count">{`${model.step}/${model.total}`}</p>}
      {model.step !== null && (
        <button className="tutorial-skip" type="button" onClick={onSkip}>
          跳过引导
        </button>
      )}
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

export interface SettingsModel {
  readonly offlineBreakthrough: boolean;
}

export function Hud({ model, onBookAction, onChallenge, onArtifactAction, onCloseRetreat }: { readonly model: HudModel; readonly onBookAction: (action: BookAction) => void; readonly onChallenge: () => void; readonly onArtifactAction: (id: string) => void; readonly onCloseRetreat: () => void }) {
  const qiRef = useRef<HTMLParagraphElement>(null);
  const prevQiRef = useRef(model.qi);

  useEffect(() => {
    if (prevQiRef.current !== model.qi && qiRef.current) {
      qiRef.current.classList.remove('is-rolling');
      void qiRef.current.offsetWidth;
      qiRef.current.classList.add('is-rolling');
      prevQiRef.current = model.qi;
    }
  }, [model.qi]);

  return (
    <aside className="hud">
      {/* 固定区：灵力/境界/试炼 */}
      <div className="hud-fixed">
        <div className="qi-card">
          <p className="label">灵力</p>
          <p ref={qiRef} className="qi tut-target">{model.qi}</p>
          <p className="rate tut-target">{model.rate.toFixed(1)} / 秒</p>
        </div>
        {model.toast !== null && <p className="toast" role="status">{model.toast}</p>}
        {model.retreat !== null && <RetreatPanel report={model.retreat} onClose={onCloseRetreat} />}
        <RealmPanel model={model.realm} qi={model.qi} />
        <SprintPanel model={model.sprint} />
      </div>

      {/* 分隔线 + 渐隐遮罩 */}
      <div className="hud-divider" />

      {/* 滚动区：曲线/渡劫/功法与道具 */}
      <div className="hud-scroll">
        <CurvePanel model={model.curve} />
        <ChallengePanel model={model.challenge} demo={model.demo} onPress={onChallenge} />
        <BookArtifactPanel
          bookModel={model.book}
          artifactRows={model.artifacts}
          onBookAction={onBookAction}
          onArtifactToggle={onArtifactAction}
        />
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
        <p className="tool-hint">{model.toolHint}</p>
      </div>
    </aside>
  );
}
