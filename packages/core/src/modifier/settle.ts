import type { Content } from '../content/schema';
import type { ActionOutcome, ActionRequest, ActionSink } from '../vm/interpreter';

// 契约 §2.2：第 k 次动作的边际递减乘数。
export function actionMult(k: number): number {
  return 1 / (1 + 0.25 * (k - 1));
}

export interface SettleDeps {
  readonly content: Content;
  readonly realmIndex: number;
  /** 任务 8 装备玉简后传 true；未装备时重复 actionId 只被观察，不改产出。 */
  readonly jadeCache?: boolean | undefined;
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
      return { qi, demonDelta: def.demonDelta };
    },
  };
}
