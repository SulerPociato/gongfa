import { BASE_BUDGET } from '../types';
import { MAX_LOOP_DEPTH, type Op } from './program';

// 批次 2 补充裁定：HUD 那句「每秒 N 灵力 · 动作 M · 层 K」以前是数工具箱积木得的（M = 积木数），
// 而一 tick 真正执行的是 VM 展开后的 M 次动作（契约 §4.2「每次执行都算一遍 k」）。
// 本模块是那个展开结果的唯一出处：静态展开与 VM 的预算/循环/跳转口径必须同一条，否则两处读数会分叉。
// 与 modifier/settle.ts 一样，这里只出「用了哪几种动作、第几层」，数值仍由 sink 算 —— 不许在这里造第二份数学。

export interface ActionProfile {
  /** 依执行序的动作 id：下标 + 1 就是契约 §2.2 的动作槽 k。 */
  readonly kinds: readonly string[];
  /** 与 kinds 同下标：该动作发生时的循环层数（顶层 0，循环体内 1，嵌套 2…）。 */
  readonly depths: readonly number[];
  /** 走过的指令步数：跨程序累加，预算是每 tick 总池（契约 §4.3）。 */
  readonly steps: number;
  /** depths 的最大值：HUD 那个「层」。 */
  readonly loopDepthMax: number;
  /** 本 tick 因预算或深度上限没跑完。 */
  readonly truncated: boolean;
}

/**
 * 把「本 tick 装载的所有程序」静态展开成一份执行序列，不建栈、不启动 VM。
 *
 * 口径逐条照 {@link Vm.tick}（vm/interpreter.ts）：
 * - 每条指令 1 步；每程序一条 HALT，HALT 计步后正常退出（HALT 那一步是 VM 实计的，别把它当免费）。
 * - `LOOP_BEGIN` 就地按字面次数展开，`LOOP_END` 每轮 1 步回边；`count === 0` 整段跳过且不计数；
 *   超过 {@link MAX_LOOP_DEPTH} 就停在本层并标 `truncated`（VM 在这里 abort 本程序）。
 * - `JMP_IF_FALSE` 一律走「条件不成立」那一支（与曲线预览同一个裁定：按 else 估，面板已写明未计分支）。
 * - 预算是跨程序共享的总池：前一程序吃掉的步数，后一程序拿不到；跑不完就 `truncated`。
 */
export function tickProfile(codes: readonly (readonly Op[])[], budget: number = BASE_BUDGET): ActionProfile {
  const kinds: string[] = [];
  const depths: number[] = [];
  let steps = 0;
  let loopDepthMax = 0;
  let truncated = false;

  // run(from, to, depth)：执行 code[from..to)。返回 true = 撞到 HALT，本程序到此为止。
  const run = (code: readonly Op[], from: number, to: number, depth: number): boolean => {
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
          kinds.push(op.actionId);
          depths.push(depth);
          if (depth > loopDepthMax) loopDepthMax = depth;
          pc += 1;
          break;
        case 'LOOP_BEGIN': {
          if (op.count === 0) {
            pc = op.end + 1;
            break;
          }
          if (depth >= MAX_LOOP_DEPTH) {
            truncated = true;
            return false;
          }
          for (let index = 0; index < op.count; index += 1) {
            if (run(code, pc + 1, op.end + 1, depth + 1)) return true;
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

  for (const code of codes) {
    if (truncated) break;
    run(code, 0, code.length, 0);
  }

  return { kinds, depths, steps, loopDepthMax, truncated };
}
