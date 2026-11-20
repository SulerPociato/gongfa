import type { Content, RealmDef } from '../content/schema';
import { actionMult } from '../modifier/settle';
import { Qi } from '../number/bignum';
import { passivePerTick } from '../realm/rules';
import { BASE_BUDGET, TICKS_PER_SEC } from '../types';
import { MAX_LOOP_DEPTH, type Op } from '../vm/program';

// 任务 8 P0-B：曲线预览（01-design §11.4、架构 §曲线预览「简化模型跑 600 tick，不启动 VM」）。
// 存在的理由是修「一直在等」：搭完积木要能立刻看见「这么改值多少」，而不是等 100 秒验证猜想。
// 刻意不建模心魔、杂念、走火与玉简命中 —— 那四项让曲线变成噪声，而玩家要的是写法之间的相对比较；
// 面板必须把这句写在脸上，否则玩家会拿它当承诺。

/** 预览窗口：60 秒（架构写死的 600 tick）。 */
export const PREVIEW_SECONDS = 60;
export const PREVIEW_TICKS = PREVIEW_SECONDS * TICKS_PER_SEC;
/** 每秒一个点：60 点画得出折线，又不至于让 SVG 里有 600 个顶点。 */
export const PREVIEW_POINTS = PREVIEW_SECONDS;

export interface Linearized {
  /** 依执行序的动作 id；每 tick 第 N 次动作的 k 就是下标 + 1（VM 的 actionSeq 同口径）。 */
  readonly actionIds: readonly string[];
  /** 走过的指令步数（含算术与控制流，与 VM 的 steps 同口径）。 */
  readonly steps: number;
  /** 被指令预算截断：程序还有得跑，这一 tick 跑不完。 */
  readonly truncated: boolean;
}

export interface CurveInput {
  readonly content: Content;
  readonly realmIndex: number;
  /** 单个程序的 IR（P0 只有一个「每 tick」入口，契约 §4.4）。 */
  readonly code: readonly Op[];
  /** 每 tick 指令预算：装备算盘会抬高它，宿主把 VM 的真池传进来。 */
  readonly budget?: number | undefined;
}

export interface CurvePreview {
  /** 60 个点：第 k 个是「从零攒到第 k 秒末」的累计产出，逐 tick 相加得到，不是速率乘秒数。 */
  readonly points: readonly Qi[];
  readonly perTick: Qi;
  readonly perSec: Qi;
  /** 当前境界阈值：画那条水平参考线用。 */
  readonly threshold: Qi;
  readonly realmIndex: number;
  /** 从零攒到阈值的预计秒数；产出为 0 时是 null（不是 Infinity，UI 画不出）。 */
  readonly etaSec: number | null;
  /** 60 秒窗口内够不够到阈值：决定参考线落在图内还是图外，面板据此说「超出本图」。 */
  readonly reachesInWindow: boolean;
  readonly steps: number;
  readonly truncated: boolean;
}

/**
 * 静态线性化：把 IR 压成「一 tick 内依次执行哪些动作」，不建栈、不启动 VM。
 *
 * - `LOOP_BEGIN` 按字面次数就地展开（展开次数由预算收口，嵌套再深也超不过 budget 步）。
 * - `JMP_IF_FALSE` 一律走「条件不成立」，即跳到 else 入口 —— 参考策略「如果 心魔>0.5 则 调息 否则 循环吐纳」
 *   因此按吐纳那一支估。这会让带条件的程序被高估（真打心魔时会切去调息），所以面板要写明没算分支。
 * - 步数口径照 VM：每条指令 1 步，玉简免步不建模。
 */
export function linearizeProgram(code: readonly Op[], budget: number = BASE_BUDGET): Linearized {
  const actionIds: string[] = [];
  let steps = 0;
  let truncated = false;

  // run(from, to)：执行 code[from..to)，返回 HALT 与否。循环体递归调用自己 count 次。
  const run = (from: number, to: number, depth: number): boolean => {
    let pc = from;
    while (pc < to) {
      if (steps >= budget) {
        truncated = true;
        return false;
      }
      const op = code[pc];
      if (op === undefined) return false;
      steps += 1;
      switch (op.op) {
        case 'ACTION':
          actionIds.push(op.actionId);
          pc += 1;
          break;
        case 'LOOP_BEGIN': {
          // 契约 §4.2 的 count===0：整个循环体不执行，直接落到 end+1（与 VM 同一支）。
          if (op.count === 0) {
            pc = op.end + 1;
            break;
          }
          // 嵌套深度失控（坏 IR）就停在这里：预算是最后防线，但先留一句可观察的 truncated。
          if (depth >= MAX_LOOP_DEPTH) {
            truncated = true;
            return false;
          }
          for (let index = 0; index < op.count; index += 1) {
            if (run(pc + 1, op.end + 1, depth + 1)) return true;
            if (truncated) return false;
          }
          pc = op.end + 1;
          break;
        }
        case 'JMP_IF_FALSE':
          pc = op.target;
          break;
        case 'JMP':
          pc = op.target;
          break;
        case 'HALT':
          return true;
        default:
          pc += 1;
          break;
      }
    }
    return false;
  };

  run(0, code.length, 0);
  return { actionIds, steps, truncated };
}

function realmOf(content: Content, index: number): RealmDef {
  const realm = content.realms[index];
  if (realm === undefined) throw new RangeError(`realmIndex ${index} 不在 realms 表中（现有 ${content.realms.map((row) => row.id).join('/')}）`);
  return realm;
}

/**
 * 每 tick 产出 = Σ baseGain × actionMult(k) × realm.actionMult + 境界被动。
 * 乘序照契约 §2.1 与 settle.makeActionSink（心魔/杂念/玉简三项按 1 略过），所以同一份程序
 * 在无干扰时与真 VM 逐位相同 —— 曲线不是第二套数学，只是省掉了那三项。
 */
function tickGain(actionIds: readonly string[], content: Content, realm: RealmDef): Qi {
  const actions = new Map(content.actions.map((action) => [action.id, action]));
  let gain = Qi.zero;
  for (let index = 0; index < actionIds.length; index += 1) {
    const def = actions.get(actionIds[index] ?? '');
    // 表里没有的 id：verifier 那条红字已经在 HUD 上说过，这里按 0 产出继续画，不能让预览把页面崩掉。
    if (def === undefined) continue;
    gain = Qi.add(gain, def.baseGain * actionMult(index + 1) * realm.actionMult);
  }
  return Qi.add(gain, passivePerTick(realm));
}

export function previewCurve(input: CurveInput): CurvePreview {
  const budget = input.budget ?? BASE_BUDGET;
  const realm = realmOf(input.content, input.realmIndex);
  const linear = linearizeProgram(input.code, budget);
  const perTick = tickGain(linear.actionIds, input.content, realm);

  // 逐 tick 累加、每 10 tick 记一个点：与在线记账同一条加法顺序。
  const points: Qi[] = [];
  let accumulated = Qi.zero;
  for (let tick = 1; tick <= PREVIEW_TICKS; tick += 1) {
    accumulated = Qi.add(accumulated, perTick);
    if (tick % TICKS_PER_SEC === 0) points.push(accumulated);
  }

  // 预计秒数是解析值：阈值 ÷ 每秒产出，向上取整（0.4 秒的零头也算一秒，玩家按秒等）。
  const perSec = perTick * TICKS_PER_SEC;
  return {
    points,
    perTick,
    perSec,
    threshold: realm.threshold,
    realmIndex: input.realmIndex,
    etaSec: perSec > 0 ? Math.ceil(realm.threshold / perSec) : null,
    reachesInWindow: perSec > 0 && realm.threshold / perSec <= PREVIEW_SECONDS,
    steps: linear.steps,
    truncated: linear.truncated,
  };
}
