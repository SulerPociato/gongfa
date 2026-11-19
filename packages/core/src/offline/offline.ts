import type { RealmDef } from '../content/schema';
import { Qi } from '../number/bignum';
import { armCharge, isChargeReady, isThresholdReached, passivePerTick, resolveChallenge } from '../realm/rules';
import { TICK_MS } from '../types';
import type { ActionOutcome, ActionRequest, ActionSink, TickResult, Vm } from '../vm/interpreter';

// 任务 7B：离线结算（契约 §7.2「逐 tick 快进」+ 架构 §七）。
// 复用在线那台 VM 与同一个 sink：产出乘数链（§2.1）只有一份，离线不可能和在线算出两种数。

/** 契约 §7.2「封顶 60 分钟」：超过 60 分钟仍按 60 分钟结算（是给，只是打折给）。 */
export const OFFLINE_CAP_MS = 60 * 60_000;

/**
 * 契约 §7.2 的系数，取常量而不是存档里的 state.offlineRate（评审 G5）：
 * 档面那个 0.6 是 §5.1 要求落盘的面值，改成 1 就白拿 40%，不采信。
 */
export const OFFLINE_RATE = 0.6;

/** 契约 §7.1 离线行：「每次离线最多 1 次」。 */
export const MAX_OFFLINE_BREAKTHROUGHS = 1;

// 时钟被回拨、或 lastSeenAt 被改成未来：按「没离线」处理而不是倒扣，负 elapsed 会直接把存量吃出一个洞。
export function offlineElapsedMs(now: number, lastSeenAt: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(lastSeenAt)) return 0;
  return Math.min(OFFLINE_CAP_MS, Math.max(0, now - lastSeenAt));
}

// 不足一个 tick 的零头不补：100ms 以下没有产出可言，floor 也让「重放同一档」稳定。
export function offlineTicks(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / TICK_MS);
}

/**
 * 评审 G1 的执行处：契约 §7.2 要求离线期间 `demonDelta` **一律归零**。
 * 只清心魔，qi 与 stepCost（玉简命中的免步）必须原样穿过，否则动作产出就换了一套口径。
 * 收 getter 而不是收实例：渡劫换境界后宿主会重建 sink，闭包读的是「当下这一份」，不会留着旧 actionMult。
 */
export function demonlessSink(source: () => ActionSink): ActionSink {
  return {
    execute(request: ActionRequest): ActionOutcome {
      const outcome = source().execute(request);
      return outcome.demonDelta === 0 ? outcome : { ...outcome, demonDelta: 0 };
    },
  };
}

/**
 * 离线期间被就地推进的世界。宿主把自已那份可变状态映射进来（qi 每 tick 都会被写），
 * VM 的 LOAD 也从这里读，所以「虚拟存量」和「程序看到的存量」始终是同一个数。
 */
export interface OfflineWorld {
  qi: Qi;
  /** 只读：契约 §7.2 离线不涨心魔，本模块只在渡劫成功那一步按 §7.1 把它涤成 0。 */
  demon: number;
  realmIndex: number;
  /** §7.3 的达标时刻：离线首次达标也要 arm，宿主结算完直接落盘。 */
  chargeReadyAt: number;
  /** 本境界内第 N 次挑战（§7.1 索引段）：与在线共用同一个计数器，保底照常生效（评审 G2）。 */
  attempt: number;
  seed: number;
}

export interface OfflineInput {
  readonly vm: Vm;
  readonly realms: readonly RealmDef[];
  readonly world: OfflineWorld;
  readonly now: number;
  readonly lastSeenAt: number;
  /** 玩家偏好（gongfa:settings），关闭时离线绝不代玩家冲关。 */
  readonly allowBreakthrough: boolean;
  /** 目标境界下标 → 蓄势窗口毫秒。窗口长度是宿主策略（演示模式 / ?charge=0 会给 0），core 不做主张。 */
  readonly chargeWindowMs: (realmIndex: number) => number;
  /** 境界已换成 realmIndex，宿主在此重建 sink；产出乘数链跟着境界走，晚一步就用旧表算新境。 */
  readonly onBreakthrough?: ((realmIndex: number) => void) | undefined;
}

export interface OfflineBreakthrough {
  readonly realm: number;
  readonly ok: boolean;
}

export type OfflineStopReason = 'threshold' | 'cap';

/**
 * 契约 §7.2 的 OfflineResult。那里把灵力写成 string（§5.1 的 BigNumber 序列化口径），
 * 这里保持 Qi 数值、由宿主在落盘与展示时 Qi.format —— 与 runtime 其余数字同一套。
 */
export interface OfflineResult {
  readonly elapsedMs: number;
  /** 计划要跑的 tick 数（clamp + floor 之后）。 */
  readonly ticks: number;
  /** 实际跑掉的 tick 数：失败停在阈值时小于 ticks。 */
  readonly ran: number;
  /** 未打折产出：报告里「同期在线口径约 +X（未扣心魔、杂念与走火损失）」那一行。 */
  readonly rawGained: Qi;
  readonly creditedGained: Qi;
  readonly breakthroughs: readonly OfflineBreakthrough[];
  readonly finalQi: Qi;
  readonly finalRealm: number;
  /** 'threshold' = 渡劫失败停表；'cap' = 时间跑完（含 0 tick）。 */
  readonly stoppedReason: OfflineStopReason;
  /** 被指令预算截断的 tick 数：产出偏低时用它分辨「程序没写完」还是「闭关时间短」。 */
  readonly stalledTicks: number;
}

function realmAt(realms: readonly RealmDef[], index: number): RealmDef {
  const realm = realms[index];
  if (realm === undefined) throw new RangeError(`realmIndex ${index} 不在 realms 表中（现有 ${realms.map((row) => row.id).join('/')}）`);
  return realm;
}

/**
 * 逐 tick 快进：每 tick 的入账是 `(动作产出 + 境界被动) × 0.6`，直接写进 world.qi。
 * 折算是**按 tick 折**而不是最后一次性乘（评审 G3 的条款只有在前者下成立）：
 * 「达标」于是发生在玩家真拿得到那些存量的那一刻，VM 里 `如果 存量 > X` 之类的分支
 * 看到的也是打折后的存量，不会出现「程序按从未存在的存量做决定」。
 */
export function settleOffline(input: OfflineInput): OfflineResult {
  const realms = input.realms;
  const world = input.world;
  const elapsedMs = offlineElapsedMs(input.now, input.lastSeenAt);
  const ticks = offlineTicks(elapsedMs);
  // 夹过上限后的区间起点：末段的虚拟时刻正好落在 now（只差一个不足 tick 的余数）
  const from = input.now - elapsedMs;

  let rawGained = Qi.zero;
  let creditedGained = Qi.zero;
  let ran = 0;
  let stalledTicks = 0;
  let attempted = 0;
  let stoppedReason: OfflineStopReason = 'cap';
  const breakthroughs: OfflineBreakthrough[] = [];

  input.vm.fastForward(ticks, (result: TickResult): 'stop' | void => {
    ran += 1;    if (result.stall !== null) stalledTicks += 1;

    const realm = realmAt(realms, world.realmIndex);
    // 契约 §2.3：被动是与动作产出并列的加法项，不进食根乘数链，也不该被离线漏掉（评审 Q1）
    const gain = Qi.add(result.gain, passivePerTick(realm));
    rawGained = Qi.add(rawGained, gain);
    const credited = Qi.mul(gain, OFFLINE_RATE);
    creditedGained = Qi.add(creditedGained, credited);
    world.qi = Qi.add(world.qi, credited);

    // 蓄势按真实时间（§7.3「不受 60 分钟产出上限约束」）：tick 序号换成毫秒，就是这一 tick 的虚拟此刻
    const virtualNow = Math.min(input.now, from + ran * TICK_MS);
    const armed = armCharge({ realm, windowMs: input.chargeWindowMs(world.realmIndex), qi: world.qi, chargeReadyAt: world.chargeReadyAt, now: virtualNow });
    if (armed !== world.chargeReadyAt) world.chargeReadyAt = armed;

    if (input.allowBreakthrough && attempted < MAX_OFFLINE_BREAKTHROUGHS) {
      const next = realms[world.realmIndex + 1];
      // 末境没有下一劫可冲：不尝试也**不中止**（评审 Q3），否则元婴玩家每次闭关卡死。
      if (next !== undefined && isThresholdReached(world.qi, realm) && isChargeReady(world.chargeReadyAt, virtualNow)) {
        attempted += 1;
        const outcome = resolveChallenge({
          realms,
          realmIndex: world.realmIndex,
          state: { qi: world.qi, demon: world.demon, realm: realm.id },
          seed: world.seed,
          attempt: world.attempt,
          mode: 'auto',
        });
        // 门槛在上面已经判全，走到拒绝说明 world.attempt 是坏值：放弃本轮尝试，不能每 tick 重试一次。
        if (outcome.errors.length > 0) return;
        if (outcome.ok) {
          // §7.1 成功的后果：境界 +1、qi = 0、demon = 0。涤心是这条规则本身，不属于「离线涨心魔」。
          world.qi = outcome.state.qi;
          world.demon = outcome.state.demon;
          world.realmIndex = outcome.realmIndex;
          // 新境界的蓄势重新起算，尝试序号也回到 1 —— 与在线 settle 同一套写法。
          world.chargeReadyAt = 0;
          world.attempt = 1;
          breakthroughs.push({ realm: next.id, ok: true });
          input.onBreakthrough?.(outcome.realmIndex);
          return;
        }
        // §7.1 离线失败「无惩罚」：不打 ×0.85、不清心魔、不发悟道。
        // §7.2 停在阈值：达标那一 tick 超出阈值的零头作废，入账按钉回后的轴修平（评审 G3）。
        world.attempt += 1;
        creditedGained = Qi.add(creditedGained, Qi.sub(realm.threshold, world.qi));
        world.qi = realm.threshold;
        breakthroughs.push({ realm: next.id, ok: false });
        stoppedReason = 'threshold';
        return 'stop';
      }
    }
    return;
  });

  // 防御性收口：afterTick 不该能让 ran 超过申请数（真出现说明 fastForward 的早停语义破了）
  if (ranTicks > ran) ran = ranTicks;

  return {
    elapsedMs,
    ticks,
    ran,
    rawGained,
    creditedGained,
    breakthroughs,
    finalQi: world.qi,
    finalRealm: realmAt(realms, world.realmIndex).id,
    stoppedReason,
    stalledTicks,
  };
}
