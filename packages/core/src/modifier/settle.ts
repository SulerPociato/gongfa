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

export interface SettleDeps {
  readonly content: Content;
  readonly realmIndex: number;
  /** 任务 8 装备玉简后传 true；未装备时重复 actionId 只被观察，不改产出。 */
  readonly jadeCache?: boolean | undefined;
  /** 心魔基线，默认契约 §2.2.1 的 0.00005；任务 10 用它跑 0.00004/0.00005 两档。 */
  readonly demonBase?: number | undefined;
}

export interface SettleSink extends ActionSink {
  /** 本 tick 起累计的「同 actionId 重复执行」次数（第 2 次起计 1），用于 UI 与单测观察。 */
  readonly observed: { readonly repeats: number };
}

// 契约 §2.1 的单动作产出：baseAction × actionMult(k) × cacheHitMult × realmActionMult。
// bookDecay（§2.1，任务 5 功法书）与 artifactMult（任务 8）在 P0 恒为 1，装载点就在这里。
export function makeActionSink(deps: SettleDeps): SettleSink {
  const realm = deps.content.realms[deps.realmIndex];
  if (realm === undefined) throw new RangeError(`realmIndex ${deps.realmIndex} 不在 realms.json 中`);
  const actions = new Map(deps.content.actions.map((action) => [action.id, action]));
  const jadeCache = deps.jadeCache ?? false;
  const demonBase = deps.demonBase ?? DEMON_BASE_PER_ACTION;
  const seen = new Set<string>();
  const observed = { repeats: 0 };

  return {
    observed,
    execute(request: ActionRequest): ActionOutcome {
      // VM 只传 k：actionSeq 每 tick 从 1 重新计数，所以 k===1 就是 tick 边界，sink 不必额外挂 tick 钩子。
      if (request.k === 1) seen.clear();
      const def = actions.get(request.actionId);
      if (def === undefined) throw new RangeError(`actionId "${request.actionId}" 不在 actions.json 中`);
      const repeat = seen.has(def.id);
      if (repeat) observed.repeats += 1;
      seen.add(def.id);
      const qi = def.baseGain * actionMult(request.k) * (jadeCache && repeat ? 0.7 : 1) * realm.actionMult;
      // 累加后的 demon 由调用方夹到 0..1；demon >= 1.0 的走火入魔惩罚（qi ×0.7、心魔归 0）在任务 6 实现，
      // 本轮不静默：增长照算，只是不触发惩罚。
      return { qi, demonDelta: def.demonDelta + demonGrowth(demonBase, def.kind, request.loopDepth) };
    },
  };
}
