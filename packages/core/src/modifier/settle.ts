import type { Modifier, ModifierTarget } from '../content/books';
import type { Content } from '../content/schema';
import { DEMON_BASE_PER_ACTION } from '../types';
import type { ActionOutcome, ActionRequest, ActionSink } from '../vm/interpreter';

// 契约 §2.2：第 k 次动作的边际递减乘数。
export function actionMult(k: number): number {
  return 1 / (1 + 0.25 * (k - 1));
}

// 契约 §2.2.1：产出动作的心魔增长。kind 非 gain 时不增长，只用表里的 demonDelta。
export function demonGrowth(demonBase: number, kind: string, loopDepth: number): number {
  return kind === 'gain' ? demonBase * (1 + 0.5 * loopDepth) : 0;
}

// 架构 §4 的「先加后乘」：先乘来源给的倍率，再加来源给的常数，最后各自夹一次。
// 上限是防改档/坏表的兜底，不是平衡数值（契约 §2.1 的乘数链本身不设上限）。
const RATE_MULT_MAX = 5;
const DEMON_MULT_MAX = 3;

export interface ResolvedModifiers {
  /** 作用在动作 qi 链上的产出乘数（已含 rate 的 add 项与夹取）。 */
  readonly rateMult: number;
  /** 作用在 demonDelta 上的心魔乘数（已含 demonRate 的 add 项与夹取）。 */
  readonly demonMult: number;
  /** 按 target 分组的 add 项原值：budget / offlineRate / slot 留给任务 8 的结算层读，这里不消费。 */
  readonly add: Readonly<Record<ModifierTarget, number>>;
  /** 被丢弃的 modifier id（未消费的 target、非法 kind、非有限或负的 mul），供 HUD 与单测观察。 */
  readonly ignored: readonly string[];
}

export function resolveModifiers(modifiers: readonly Modifier[]): ResolvedModifiers {
  // 同 id 只留最后一个：重复装备同一本书不该叠乘（架构 §4 点名的「重复装备」）
  const byId = new Map<string, Modifier>();
  for (const modifier of modifiers) byId.set(modifier.id, modifier);

  const add: Record<ModifierTarget, number> = { rate: 0, demonRate: 0, budget: 0, offlineRate: 0, slot: 0 };
  let rateMult = 1;
  let demonMult = 1;
  const ignored: string[] = [];

  for (const modifier of byId.values()) {
    const consumed = modifier.target === 'rate' || modifier.target === 'demonRate';
    if (!consumed) ignored.push(modifier.id);
    if (!Number.isFinite(modifier.value) || (modifier.kind !== 'mul' && modifier.kind !== 'add')) {
      if (consumed) ignored.push(modifier.id);
      continue;
    }
    if (modifier.kind === 'mul') {
      // mul 为负会把灵力刷成反向数字，整条丢弃而不是取绝对值：坏表要响，不要静默纠正
      if (modifier.value < 0) {
        if (consumed) ignored.push(modifier.id);
        continue;
      }
      if (modifier.target === 'rate') rateMult *= modifier.value;
      else if (modifier.target === 'demonRate') demonMult *= modifier.value;
    } else {
      add[modifier.target] += modifier.value;
    }
  }

  rateMult = Math.min(RATE_MULT_MAX, Math.max(0, rateMult));
  demonMult = Math.min(DEMON_MULT_MAX, Math.max(0, demonMult));
  return {
    rateMult: Math.min(RATE_MULT_MAX, Math.max(0, rateMult + add.rate)),
    demonMult: Math.min(DEMON_MULT_MAX, Math.max(0, demonMult + add.demonRate)),
    add,
    ignored,
  };
}

export interface SettleDeps {
  readonly content: Content;
  readonly realmIndex: number;
  /** 任务 8 装备玉简后传 true；未装备时重复 actionId 只被观察，不改产出。 */
  readonly jadeCache?: boolean | undefined;
  /** 心魔基线，默认契约 §2.2.1 的 0.00005；任务 10 用它跑 0.00004/0.00005 两档。 */
  readonly demonBase?: number | undefined;
  /** 契约 §2.2 的书衰减，默认 1（无书或已固化）。只作用动作 qi，不碰心魔（§6）。 */
  readonly bookDecay?: number | undefined;
  /** 契约 §6：装备来源的修正。卸下或固化时必须传空数组，与装载成对。 */
  readonly modifiers?: readonly Modifier[] | undefined;
}

export interface SettleSink extends ActionSink {
  /** 本 tick 起累计的「同 actionId 重复执行」次数（第 2 次起计 1），用于 UI 与单测观察。 */
  readonly observed: { readonly repeats: number };
  /** 结算实际吃到的乘数，卸下书后应当回到 1 / 1，供 HUD 与单测观察。 */
  readonly mults: { readonly bookDecay: number; readonly rateMult: number; readonly demonMult: number };
}

// 契约 §2.1 的单动作产出：baseAction × actionMult(k) × cacheHitMult × realmActionMult × bookDecay × rateMult。
// artifactMult（任务 8）在这条链的末尾等着。
export function makeActionSink(deps: SettleDeps): SettleSink {
  const realm = deps.content.realms[deps.realmIndex];
  if (realm === undefined) throw new RangeError(`realmIndex ${deps.realmIndex} 不在 realms.json 中`);
  const actions = new Map(deps.content.actions.map((action) => [action.id, action]));
  const jadeCache = deps.jadeCache ?? false;
  const demonBase = deps.demonBase ?? DEMON_BASE_PER_ACTION;
  const bookDecay = deps.bookDecay ?? 1;
  if (!Number.isFinite(bookDecay) || bookDecay < 0) throw new RangeError(`bookDecay 需要 ≥ 0 的有限数，收到 ${String(deps.bookDecay)}`);
  const mods = resolveModifiers(deps.modifiers ?? []);
  const seen = new Set<string>();
  const observed = { repeats: 0 };

  return {
    observed,
    mults: { bookDecay, rateMult: mods.rateMult, demonMult: mods.demonMult },
    execute(request: ActionRequest): ActionOutcome {
      // VM 只传 k：actionSeq 每 tick 从 1 重新计数，所以 k===1 就是 tick 边界，sink 不必额外挂 tick 钩子。
      if (request.k === 1) seen.clear();
      const def = actions.get(request.actionId);
      if (def === undefined) throw new RangeError(`actionId "${request.actionId}" 不在 actions.json 中`);
      const repeat = seen.has(def.id);
      if (repeat) observed.repeats += 1;
      seen.add(def.id);
      const qi = def.baseGain * actionMult(request.k) * (jadeCache && repeat ? 0.7 : 1) * realm.actionMult * bookDecay * mods.rateMult;
      // 累加后的 demon 由调用方夹到 0..1；demon >= 1.0 的走火入魔惩罚（qi ×0.7、心魔归 0）在任务 6 实现，
      // 本轮不静默：增长照算，只是不触发惩罚。
      // 架构 §4 的先加后乘（O1）：心魔乘数作用在「表值 + 增长项」整体之上，负 demonDelta（调息）同样被缩放。
      return { qi, demonDelta: (def.demonDelta + demonGrowth(demonBase, def.kind, request.loopDepth)) * mods.demonMult };
    },
  };
}
