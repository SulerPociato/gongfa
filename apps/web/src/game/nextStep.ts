import type { RuntimeState } from './runtime';

/**
 * 「下一步」提示（批次 7）。
 *
 * 存在的理由：实测四个境界下，玩家攒满灵力后第一眼看的是 HUD，而 HUD 里
 * 没有任何一句话告诉他"现在该点哪里"。渡劫按钮上浮解决了"看得见"，
 * 这一行解决"知不知道"。
 *
 * 文案刻意短（≤ 18 个字）：它坐在灵力卡里，长一行就把固定区撑高，
 * 曲线会被挤出首屏（实测 130 → 170px，curve top 714）。
 *
 * 纯函数：输入 runtime 的只读快照 + 宿主知道的"有没有程序"。
 * 优先级按"卡住玩家的程度"排，越靠前越紧急。
 */
export interface NextStepInput {
  readonly state: RuntimeState;
  /** 画布上有没有可执行的程序（编译失败会保留上一份 lastGood，runtime 自己分不清）。 */
  readonly hasProgram: boolean;
  /** 画布上吐纳块的个数（批次 15：教「别手搓，去用循环」）。 */
  readonly breathBlocks?: number;
  /** 画布上有没有循环块。 */
  readonly hasRepeat?: boolean;
}

const NOISE_HINT = 0.7;

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function nextStepOf({ state, hasProgram, breathBlocks, hasRepeat = false }: NextStepInput): string {
  // 空画布也会编译出 HALT，所以 hasProgram 恒为真；真正该问的是「有没有动作」。
  if (!hasProgram) return '拖「吐纳」进「每 tick」';
  // 空画布也会编译出 HALT（hasProgram 恒真），所以「画布上有几块动作」才是真信号。
  if (breathBlocks === 0) return '拖「吐纳」进「每 tick」';
  if (state.pauseRemainingMs > 0) return `走火入魔：等 ${(state.pauseRemainingMs / 1000).toFixed(1)} 秒`;
  if (state.demon >= NOISE_HINT) return '心魔偏高：拖「调息」压住';
  if (state.stall !== null) return '预算撞顶：装算盘或减层';
  if (state.canChallenge) return '点「可渡劫」（不点按 60%）';
  if (state.canBreakthrough && state.chargeRemainingMs > 0) {
    return `蓄势 ${mmss(state.chargeRemainingMs)} · 试炼可减半`;
  }
  if (state.cooldownRemainingMs > 0) return `冷却 ${mmss(state.cooldownRemainingMs)} · 先改功法`;
  if (state.nextRealmName === null) return '已至末境 · 收集功法谱';
  if (state.rate <= 0) return '程序无产出：检查凹槽';
  // 批次 15：手搓吐纳是最好抓的教学时机 —— 玩家已经尝到甜头，这时才愿意学循环。
  if (!hasRepeat && breathBlocks !== undefined && breathBlocks >= 3) return '3 块吐纳可换 1 个循环';
  const remaining = Math.max(0, state.threshold - state.qi);
  return `攒 ${mmss((remaining / state.rate) * 1000)} 到阈值`;
}
