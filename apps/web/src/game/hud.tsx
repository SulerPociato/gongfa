import { useEffect, useRef, useState } from 'react';
import { AUTO_RATE, CHALLENGE_TRIAL_MS, FAILURE_QI_MULT, GUARANTEE_ATTEMPT, MANUAL_RATE, NOISE_LINE, type BookPhase, type StallEvent } from '@gongfa/core';
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
  /** 批次 8：灵根（seed 派生，只影响心魔增速），显示成一行，不参与任何计算。 */
  readonly lingGen: string;
  /** 批次 8：丹药冷却剩余毫秒；>0 时按钮显示倒计时。 */
  readonly pillCooldownMs: number;
  /** 批次 3：功法谱（算法识别）。 */
  readonly patterns: readonly PatternRow[];
}

/** 功法谱里的一行：一个算法图案的发现状态。 */
export interface PatternRow {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  readonly requires: string;
  /** 一句教学说明（已发现的条目显示它）。 */
  readonly teach: string;
  readonly found: boolean;
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
  /** 当前境名：挑战面板的标题「渡劫 · 炼气 → 筑基」两头都要真的从 runtime 拿。 */
  readonly realmName: string;
  readonly nextRealmName: string | null;
  readonly chargeRemainingMs: number;
  readonly trialRemainingMs: number;
  readonly cooldownRemainingMs: number;
  /** 下一次冲关是本境界第几次（§7.1 的 N，从 1 起）；连续失败次数 = N - 1。 */
  readonly attempt: number;
  readonly insight: number;
}

/**
 * 一次结算的结果层要读的四件事：成/败、结算前后的境名、是否保底第 N 次。
 * 全部来自 runtime 的 ChallengeResult，HUD 不回头查表，也不自己算「下一境是第几境」。
 */
export interface ChallengeOutcome {
  readonly ok: boolean;
  readonly fromRealmName: string;
  readonly realmName: string;
  readonly forced: boolean;
  readonly attempt: number;
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
  /** 同一窗口内累计执行的指令数（批次 6：试炼评分）。 */
  readonly steps: number;
  /** 每步换多少灵力 = progressQi / steps；steps 为 0 时为 0。 */
  readonly perQi: number;
  /** 本境界历史最好效率（元进度 gongfa:best:<slot>）；null = 还没达成过。 */
  readonly bestPerQi: number | null;
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
  /**
   * 批次 2 第二条线：心魔累计，与 points 同一套横轴（下标 = 第几秒末）。
   * 撞线那一格也占一位（值就是 demonMax），所以它比 points 短一截 = 「线在这儿收了」，不是数据缺失。
   */
  readonly demon: readonly number[];
  /** 右轴满刻度：core 的火线值传进来，HUD 不写死 1。 */
  readonly demonMax: number;
  /** 60 秒窗口内预计撞线的秒数；null = 压得住。文案由宿主拼，数字只在这一个地方格式化。 */
  readonly backlashAtSec: number | null;
}

export interface HudModel {
  readonly qi: number;
  readonly rate: number;
  readonly errors: readonly string[];
  readonly corrupt: CorruptLineModel | null;
  readonly stall: StallEvent | null;
  /**
   * 步数经济学（批次 5）：本 tick 用了多少步、上限多少、每步换多少灵力。
   * 三个数同源（runtime.state），HUD 不自己除——除错了就是第二个口径。
   */
  readonly steps: { readonly used: number; readonly pool: number; readonly perQi: number };
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
  /** 批次 7：下一步提示（一句话，由宿主用 nextStepOf 算好）。空串 = 不显示。 */
  readonly nextStep: string;
  /** 批次 7：道途（null = 还没选）。选过之后这张卡消失。 */
  readonly dao: 'orthodox' | 'heretic' | null;
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
function Bar({ value, of, label, kind, danger = false }: { readonly value: number; readonly of: number; readonly label: string; readonly kind: 'qi' | 'demon' | 'sprint'; readonly danger?: boolean }) {
  const percent = Math.min(100, Math.max(0, (value / of) * 100));
  return (
    <div className={`bar ${kind}${danger ? ' is-danger' : ''}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
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
  const last = model.points[model.points.length - 1] ?? 0;
  const hasData = model.points.length > 0;
  // 纵轴上限取「曲线末点与阈值的大者」：阈值那条线永远画在图里，玩家才看得见自己差多远。
  const top = Math.max(last, model.threshold, 1);
  // 横轴按秒：两条线共用同一个分母，心魔在预算截断时比灵力短，短的那截要落在同一格刻度上。
  const seconds = Math.max(model.points.length, model.demon.length);
  const x = (index: number): number => (seconds === 1 ? CURVE_W : (index / (seconds - 1)) * CURVE_W);
  const y = (value: number): number => CURVE_H - (value / top) * CURVE_H;
  // 右轴是心魔：0 在底、火线在顶，占满同一张图的高度（左轴是灵力，两套刻度不许混着读）。
  const yDemon = (value: number): number => CURVE_H - (value / model.demonMax) * CURVE_H;
  const line = model.points.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  // 渐变填充区域：从曲线到 SVG 底部
  const area = `0,${CURVE_H} ${line} ${CURVE_W},${CURVE_H}`;
  const demonLine = model.demon.map((value, index) => `${x(index).toFixed(1)},${yDemon(value).toFixed(1)}`).join(' ');
  const lastDemonIndex = model.demon.length - 1;
  // 红点钉在命中那一格；贴边时往里收半个点，否则 viewBox 的 overflow:hidden 会把它削成半圆。
  const dotY = (value: number): number => Math.min(CURVE_H - 4, Math.max(4, yDemon(value)));
  const eta = model.etaSec === null
    ? `${model.seconds} 秒内不产出灵力`
    : `预计 ${model.etaSec} 秒达标${model.reachesInWindow ? '' : `（超出本图 ${model.seconds} 秒）`}`;
  // 三个数字的写法与引导第 4 步共用 compareParts：两处各写一遍 toFixed，早晚会分叉成两个「每秒」。
  const compare = model.compare === null ? null : compareParts(model.compare.fromPerSec, model.compare.toPerSec, model.compare.percent);
  const backlash = model.backlashAtSec === null ? null : `预计 ${model.backlashAtSec} 秒后走火入魔`;
  return (
    <div className="curve">
      <p className="label">产出曲线</p>
      {/* 刻度与图例都是叠在图外的 HTML，不是 SVG 里的 text：preserveAspectRatio="none" 会把字横向压扁，
          而这几处读的是「灵力多少」和「心魔到没到火线」，看不清就等于少了一条线。 */}
      <div className="curve-plot">
        <svg className="curve-svg" viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} preserveAspectRatio="none" role="img"
          aria-label={hasData
            ? `${model.seconds} 秒产出曲线，灵力末点 ${Math.round(last)}，阈值 ${model.threshold}，${eta}；心魔末点 ${Math.round((model.demon[model.demon.length - 1] ?? 0) * 100)}%${backlash === null ? '' : `，${backlash}`}`
            : '曲线空态，拖积木后显示'}>
          <defs>
            <linearGradient id="curveGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(53, 224, 200, 0.18)" />
              <stop offset="100%" stopColor="rgba(53, 224, 200, 0)" />
            </linearGradient>
          </defs>
          {/* 底部基线 */}
          <line x1="0" y1={CURVE_H - 1} x2={CURVE_W} y2={CURVE_H - 1} stroke="rgba(53, 224, 200, 0.12)" strokeWidth="1" />
          {hasData ? (
            <>
              <polygon className="curve-area" points={area} />
              <line className="curve-threshold-line" x1="0" y1={y(model.threshold).toFixed(1)} x2={CURVE_W} y2={y(model.threshold).toFixed(1)} />
              <polyline className="curve-line" points={line} />
              {/* 心魔线走右轴虚线：阈值那支已经是虚线了，分开两条线靠的是颜色，不许再添一种线型。 */}
              {model.demon.length > 1 && <polyline className="curve-demon-line" points={demonLine} />}
              {/* 裁定 2：撞线只截断心魔这一支，红点钉在命中那一格；灵力线照画满 60 秒。 */}
              {model.backlashAtSec !== null && lastDemonIndex >= 0 && (
                <circle className="curve-danger-dot" cx={x(lastDemonIndex).toFixed(1)} cy={dotY(model.demon[lastDemonIndex] ?? 0).toFixed(1)} r="3.5" />
              )}
            </>
          ) : (
            <text x={CURVE_W / 2} y={CURVE_H / 2} fill="rgba(255,255,255,0.4)" fontSize="12" fontFamily="system-ui, sans-serif" textAnchor="middle">搭一块积木，曲线就会出来</text>
          )}
          {/* 横轴标签 */}
          <text x="0" y={CURVE_H - 4} fill="rgba(255,255,255,0.5)" fontSize="10" fontFamily="JetBrains Mono, monospace">0</text>
          <text x={CURVE_W / 2} y={CURVE_H - 4} fill="rgba(255,255,255,0.5)" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">30</text>
          <text x={CURVE_W} y={CURVE_H - 4} fill="rgba(255,255,255,0.5)" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">60</text>
        </svg>
        {hasData && (
          <p className="curve-legend">
            <span className="curve-key is-qi">灵力</span>
            <span className="curve-key is-demon">心魔</span>
          </p>
        )}
        {hasData && (
          <span className="curve-axis-right" aria-hidden="true">
            <span className="curve-tick is-top">{model.demonMax.toFixed(2)}</span>
            <span className="curve-tick is-mid">{(model.demonMax / 2).toFixed(2)}</span>
            <span className="curve-tick is-bottom">0</span>
          </span>
        )}
      </div>
      {hasData && <p className="curve-eta">{eta}</p>}
      {hasData && backlash !== null && <p className="curve-danger">{backlash}</p>}
      {hasData && compare !== null && <p className="curve-compare">产出 {compare.from} → {compare.to} / 秒（{compare.percent}%）</p>}
      {hasData && model.truncated && <p className="curve-truncated">程序超出本 tick 指令预算，曲线只算跑得完的部分</p>}
      {hasData && <p className="curve-note">直线执行估算，未计入「如果」分支、随机杂念与法宝/功法书的心魔倍率</p>}
    </div>
  );
}

function RealmPanel({ model, qi, onTakePill, onOpenCodex }: { readonly model: RealmModel; readonly qi: number; readonly onTakePill: () => void; readonly onOpenCodex: () => void }) {
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
          <Bar value={model.demon} of={1} label="心魔" kind="demon" danger={model.demon >= NOISE_LINE} />
          <p className="demon-text">
            {(model.demon * 100).toFixed(1)}%
            {model.calmText !== null && <span className="demon-calm"> {model.calmText}</span>}
          </p>
          {/* 批次 8：丹药。存量换心魔，冷却期显示倒计时 —— 它是给"入魔"用的对冲手段。 */}
          <button
            className="pill-button"
            type="button"
            onClick={onTakePill}
            disabled={model.pillCooldownMs > 0}
            title="消耗 5% 存量，心魔 -15%"
          >
            {model.pillCooldownMs > 0 ? `${Math.ceil(model.pillCooldownMs / 1000)}s` : '服丹'}
          </button>
        </div>
      </div>
      {/* 批次 3：功法谱。 */}
      <div className="realm-patterns">
        <p className="patterns-label">灵根 · {model.lingGen}</p>
        {/* 批次 10：功法谱那行就是图鉴入口。评审说得对——藏进设置抽屉没人会点，
            而"N/12"本身就是进度，看到差几个才会想点。 */}
        <button className="patterns-label is-link" type="button" onClick={onOpenCodex}>
          功法谱 {model.patterns.filter((p) => p.found).length} / {model.patterns.length} →
        </button>
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
      <p className="sprint-text">
        {model.reached
          ? `已达成 · 用了 ${model.steps} 步 · 效率 ${model.perQi.toFixed(3)} 灵力/步`
          : `${seconds} 秒内达成可减半蓄势`}
      </p>
      {!model.reached && model.steps > 0 && (
        <p className="sprint-text sprint-eff">
          当前效率 {model.perQi.toFixed(3)} 灵力/步（{model.steps} 步）
          {model.bestPerQi !== null && ` · 本境最好 ${model.bestPerQi.toFixed(3)}`}
        </p>
      )}
    </div>
  );
}

// 按钮文案按相位给，六态互斥：HUD 不做任何比较运算，phase 是宿主从 runtime 字段推出来的。
// trial 这一态不带倒计时：10 秒那个数字只出现在挑战面板的主按钮上，两处读秒迟早对不上。
const BUTTON_TEXT: Record<ChallengePhase, string> = {
  threshold: '先攒存量',
  charge: '蓄势中',
  cooldown: '冷却中',
  ready: '可渡劫',
  trial: '渡劫中',
  final: '已至末境',
};

// mm:ss：2 / 5 分钟的蓄势用分秒，不用「120 秒」让玩家自己除。
// 名字带 remain：App.tsx 另有一个把 epoch 毫秒印成 HH:MM:SS 的 clockText，两者口径不同。
function remainText(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// 百分比只有一个来源：MANUAL_RATE / AUTO_RATE 改了，面板、按钮、结果层跟着一起变。
function percent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

export function ChallengePanel({ model, demo, onPress }: { readonly model: ChallengeModel; readonly demo: boolean; readonly onPress: () => void }) {
  const sub =
    model.phase === 'charge' ? `还需 ${remainText(model.chargeRemainingMs)}`
      : model.phase === 'cooldown' ? `还剩 ${(model.cooldownRemainingMs / 1000).toFixed(1)} 秒`
        : model.phase === 'ready' && model.nextRealmName !== null ? `→ ${model.nextRealmName}`
          : '';
  return (
    <div className="challenge">
      {/* is-ready：首次「可渡劫」的脉冲动画挂在这上面（P0-C 第 4 项），只看相位，不看别的。 */}
      {/* trial 也保持可点：玩家慌乱时会习惯性按原来那颗按钮，禁用等于把入口藏起来。点下去 = 手动 85%。 */}
      <button className={`challenge-button${model.phase === 'ready' ? ' is-ready' : ''} tut-target`} type="button" disabled={!model.enabled} onClick={onPress}>
        {BUTTON_TEXT[model.phase]}
        {sub === '' ? '' : ` ${sub}`}
      </button>
      {/* 「可渡劫」= 现在可以发起一次冲关，境界要等结算成功才动。这句写在按钮正下方：
          光看「可渡劫」三个字，玩家以为点一下就进阶，进去 10 秒窗口才发现还有两个档 —— 那 10 秒是白站的。 */}
      {model.phase === 'ready' && (
        <p className="challenge-hint">
          {demo
            ? '演示模式：点一下当场按 ' + percent(MANUAL_RATE) + ' 结算（无 10 秒窗口），按 X 才走面板。'
            : `点一下进 ${(CHALLENGE_TRIAL_MS / 1000).toFixed(0)} 秒窗口：窗口内点确认 = ${percent(MANUAL_RATE)}，撒手 = ${percent(AUTO_RATE)} 托管。境界在结算之后才变。`}
        </p>
      )}
      {/* 保底与冷却都在内存里（§5.1 没这两个字段）：文案必须写明刷新清零，否则玩家以为攒到了第 2 次。 */}
      <p className="challenge-meta">
        本档连续失败 {model.attempt - 1} 次（刷新清零）· 第 {model.attempt} 次冲关{model.attempt >= GUARANTEE_ATTEMPT ? '（保底必成）' : ''} ·
        失败存量 ×{FAILURE_QI_MULT} · 悟道 {model.insight}（本档）
      </p>
    </div>
  );
}

/**
 * 渡劫挑战面板（批次 1）：10 秒窗口里的两个去向摊开摆 —— 手动 85% 与托管 60%，倒计时只写在主按钮里。
 * 它不在 HUD 里：HUD 宽 300px 塞不下「最显眼的一行」，而窗口期玩家的手还在画布上，眼睛不该被迫右移。
 * demo 那一支没有 10 秒窗口（runtime 的 pressChallenge 当场结算），所以藏掉倒计时、只留一个按钮。
 */
export function TrialPanel({ model, demo, onPress }: {
  readonly model: ChallengeModel;
  readonly demo: boolean;
  readonly onPress: (mode: 'manual' | 'auto') => void;
}) {
  return (
    <div className="trial-panel" role="dialog" aria-label="渡劫挑战">
      <p className="trial-panel-title">渡劫 · {model.realmName}{model.nextRealmName === null ? '' : ` → ${model.nextRealmName}`}</p>
      <p className="trial-panel-lead">
        {demo
          ? `演示模式：面板只由 X 键打开，点「确认冲关」当场按 ${percent(MANUAL_RATE)} 结算，无 10 秒窗口。`
          : `不操作也会自动结算（${percent(AUTO_RATE)}）；点「立即冲关」= ${percent(MANUAL_RATE)}`}
      </p>
      <div className="trial-panel-actions">
        {/* demo 那一支写「确认」而不是「立即」：窗口是 X 键开的，这一下只是确认，
            而点 HUD「可冲关」仍然是当场结算 —— 两条路的差别必须能从文案上读出来。 */}
        <button className="trial-primary" type="button" onClick={() => onPress('manual')}>
          {demo ? `确认冲关 ${percent(MANUAL_RATE)}` : `立即冲关 ${percent(MANUAL_RATE)}（${(model.trialRemainingMs / 1000).toFixed(1)}s）`}
        </button>
        {!demo && (
          <button className="trial-secondary" type="button" onClick={() => onPress('auto')}>
            交给天意 {percent(AUTO_RATE)}
          </button>
        )}
      </div>
      {/* 01-design §4.4 的「限时改功法」：改的是产出，不是概率 —— 这句必须写死，不然玩家会以为磨得越久越容易。 */}
      <p className="trial-panel-note">改功法只改接下来的产出，不改成功率。</p>
    </div>
  );
}

/**
 * 结算结果层（批次 1）：成与败都要占满一次视线，否则玩家只看见数字跳了一下。
 * 整层可点=跳过，但「满 1.5 秒才认这次点击」的闸在 App.tsx 的 onDismiss 里，不在这里。
 */
export function ChallengeResultLayer({ outcome, onDismiss }: { readonly outcome: ChallengeOutcome; readonly onDismiss: () => void }) {
  return (
    <div className={`result-layer${outcome.ok ? ' is-win' : ' is-lose'}`} role="status" aria-live="assertive" onClick={onDismiss}>
      <div className="result-talisman" aria-hidden="true" />
      <p className="result-title">{outcome.ok ? '突破成功' : '渡劫失败'}</p>
      <p className="result-sub">
        {outcome.ok ? `${outcome.fromRealmName} → ${outcome.realmName}` : `存量 ×${FAILURE_QI_MULT}，心魔归 0，可再来一次`}
      </p>
      {/* 第 3 次的成功来自保底而非骰子（§7.1）：不写出来，玩家会以为自己是 85% 里的幸运儿。 */}
      {outcome.ok && outcome.forced && <p className="result-forced">保底第 {outcome.attempt} 次，非骰值</p>}
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

export function Hud({ model, onBookAction, onChallenge, onArtifactAction, onCloseRetreat, onTakePill, onOpenCodex, onChooseDao }: { readonly model: HudModel; readonly onBookAction: (action: BookAction) => void; readonly onChallenge: () => void; readonly onArtifactAction: (id: string) => void; readonly onCloseRetreat: () => void; readonly onTakePill: () => void; readonly onOpenCodex: () => void; readonly onChooseDao: (path: 'orthodox' | 'heretic') => void }) {
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
      {/* 固定区：灵力 / 渡劫 / 境界 / 试炼。
          渡劫必须在这里：它是玩家攒满之后唯一要做的事，实测放到滚动区时
          在 1440×900 下被裁掉 3~20px（top 806/823，bottom 903/920），等于主 CTA 看不见。 */}
      <div className="hud-fixed">
        <div className="qi-card">
          <p className="label">灵力</p>
          <p ref={qiRef} className="qi tut-target">{model.qi}</p>
          <p className="rate tut-target">{model.rate.toFixed(1)} / 秒</p>
          {model.steps.used > 0 && (
            <p className={`steps${model.steps.used >= model.steps.pool ? ' is-full' : ''}`}>
              本 tick {model.steps.used} / {model.steps.pool} 步 · 效率 {model.steps.perQi.toFixed(3)} 灵力/步
            </p>
          )}
          {/* 下一步提示放在灵力卡里：独立一条会把固定区撑高 46px，曲线就被挤出首屏（实测 737→968）。 */}
          {model.nextStep !== '' && <p className="next-step" role="status">下一步：{model.nextStep}</p>}
        </div>
        {model.toast !== null && <p className="toast" role="status">{model.toast}</p>}
        {model.retreat !== null && <RetreatPanel report={model.retreat} onClose={onCloseRetreat} />}
        <ChallengePanel model={model.challenge} demo={model.demo} onPress={onChallenge} />
        <RealmPanel model={model.realm} qi={model.qi} onTakePill={onTakePill} onOpenCodex={onOpenCodex} />
        <SprintPanel model={model.sprint} />
      </div>

      {/* 分隔线 + 渐隐遮罩 */}
      <div className="hud-divider" />

      {/* 滚动区：曲线/功法与道具/红字/存档。
          曲线必须在这里：它一进固定区，固定区就吃掉整列高度（实测 858px），
          滚动区 clientHeight 变 0 —— 红字和道具面板一起消失，比"曲线看不见"更糟。 */}
      <div className="hud-scroll">
        {/* 批次 7：道途。筑基后第一次出现，选中即消失（一次定终身）。
            两条路都是"全产出"倍率；入魔的代价加在心魔基础增速上，调息压不住它。 */}
        {model.dao === null && model.realm.name !== '炼气' && (
          <section className="dao-card">
            <p className="label">选择道途（一次定终身）</p>
            <button className="dao-option" type="button" onClick={() => onChooseDao('orthodox')}>
              <span className="dao-name">守正</span>
              <span className="dao-effect">全产出 +8%，心魔照旧</span>
            </button>
            <button className="dao-option is-heretic" type="button" onClick={() => onChooseDao('heretic')}>
              <span className="dao-name">入魔</span>
              <span className="dao-effect">全产出 +12%，但心魔增速翻倍、走火更频繁</span>
            </button>
          </section>
        )}
        <CurvePanel model={model.curve} />
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
