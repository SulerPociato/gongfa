import type { Content } from '../content/schema';
import { Qi } from '../number/bignum';
import { BASE_BUDGET } from '../types';
import type { StallEvent, StallReason, VmEvent } from './events';
import { MAX_LOOP_DEPTH, MAX_VALUE_STACK_DEPTH, type CmpArg, type LoadKey, type Program } from './program';
import { verifyProgram, type VerifyIssue, type VerifyResult } from './verifier';

export interface ActionRequest {
  readonly actionId: string;
  readonly k: number;
  readonly pc: number;
  /** 契约 §2.2.1：运行期循环栈深度，只作为 sink 的入参，不进 IR。 */
  readonly loopDepth: number;
}

export interface ActionOutcome {
  readonly qi: Qi;
  readonly demonDelta: number;
  /**
   * 契约 §2.4：玉简命中的那一次 ACTION 计 hitStepCost 步。缺省（不返回该字段）就是 1，
   * 也就是说 VM 的步数口径与道具无关时逐字节不变。
   */
  readonly stepCost?: number | undefined;
}

// VM 只负责解析 ACTION 并把 k 传下去；契约 §2.1 的六个乘数由实现方在此结算，避免与 balance-sim 出现两份口径。
export interface ActionSink {
  execute(request: ActionRequest): ActionOutcome;
}

export interface VmSnapshot {
  readonly qi: Qi;
  readonly rate: Qi;
  readonly demon: number;
  readonly realm: number;
  readonly budget: number;
}

export interface TickResult {
  readonly tick: number;
  readonly steps: number;
  readonly gain: Qi;
  readonly demonDelta: number;
  readonly stall: StallEvent | null;
}

export interface VmDeps {
  readonly content: Content;
  readonly sink: ActionSink;
  readonly budgetPool?: number | undefined;
  readonly vars?: (() => VmSnapshot) | undefined;
  readonly onEvent?: ((event: VmEvent) => void) | undefined;
}

export class VmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VmError';
  }
}

interface LoopFrame {
  begin: number;
  remaining: number;
}

const ZERO_SNAPSHOT: VmSnapshot = { qi: 0, rate: 0, demon: 0, realm: 0, budget: BASE_BUDGET };

// 构造参数与 setBudget 共用一条校验：预算池是「每 tick 总预算」的整数步数，小数或负数没有意义。
function checkBudget(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`budgetPool 需要非负整数，收到 ${value}`);
  }
  return value;
}

function readVar(key: LoadKey, vars: VmSnapshot, remainingBudget: number): Qi {
  switch (key) {
    case 'qi':
      return vars.qi;
    case 'rate':
      return vars.rate;
    case 'demon':
      return vars.demon;
    case 'realm':
      return vars.realm;
    case 'budget':
      return remainingBudget;
  }
}

function compare(arg: CmpArg, left: Qi, right: Qi): 1 | 0 {
  if (arg === '<') return Qi.lt(left, right) ? 1 : 0;
  if (arg === '>') return left > right ? 1 : 0;
  return left === right ? 1 : 0;
}

export class Vm {
  private readonly content: Content;
  private readonly sink: ActionSink;
  // 可变：契约 §2.4 的算盘装备/卸下要在不重建 VM 的前提下换池（重建会丢 ticksRun，确定性回放就散了）。
  private budgetPool: number;
  private readonly vars: () => VmSnapshot;
  private readonly onEvent: ((event: VmEvent) => void) | undefined;
  private installed: readonly Program[] = [];
  private ticksRun = 0;

  constructor(deps: VmDeps) {
    this.content = deps.content;
    this.sink = deps.sink;
    this.budgetPool = checkBudget(deps.budgetPool ?? BASE_BUDGET);
    this.vars = deps.vars ?? (() => ZERO_SNAPSHOT);
    this.onEvent = deps.onEvent;
  }

  get programs(): readonly Program[] {
    return this.installed;
  }

  get currentTick(): number {
    return this.ticksRun;
  }

  get budget(): number {
    return this.budgetPool;
  }

  /**
   * 契约 §2.4 的预算加成入口。只在两次 tick 之间调用（装备/卸下发生在 rAF 回调里）：
   * 本 tick 已计出的 steps 与已发出去的 stall 不回溯，新池从下一次 tick 的预算检查起生效。
   */
  setBudget(budgetPool: number): void {
    this.budgetPool = checkBudget(budgetPool);
  }

  // 校验不通过则一个程序都不装载，错误按 [programId] 前缀汇总。
  loadPrograms(programs: readonly Program[]): VerifyResult {
    const errors: VerifyIssue[] = [];
    const warnings: string[] = [];

    for (const program of programs) {
      const result = verifyProgram(program, this.content);
      for (const issue of result.errors) {
        errors.push({ check: issue.check, pc: issue.pc, message: `[${program.id}] ${issue.message}` });
      }
      for (const warning of result.warnings) {
        warnings.push(`[${program.id}] ${warning}`);
      }
    }

    this.installed = errors.length === 0 ? [...programs] : [];
    return { ok: errors.length === 0, errors, warnings };
  }

  /** @internal 跳过 verifier 直接装载：只给测试和未来的存档快进用，玩家编译产物必须走 loadPrograms。 */
  installUnchecked(programs: readonly Program[]): void {
    this.installed = [...programs];
  }

  tick(): TickResult {
    this.ticksRun += 1;
    const tick = this.ticksRun;
    const vars = this.vars();
    let steps = 0;
    let gain = Qi.zero;
    let demonDelta = Qi.zero;
    let actionSeq = 0;

    // 契约 §4.3「中止本程序本 tick」只掐当前程序，后续程序继续跑（P0 只有 programs[0]，先把口径立住）。
    // 每次 stall 都进 onEvent；TickResult.stall 是单数字段，只留本 tick 第一个。
    let firstStall: StallEvent | null = null;
    const abort = (programId: string, pc: number, reason: StallReason): void => {
      const event: StallEvent = { t: 'stall', programId, pc, steps, tick, reason };
      this.onEvent?.(event);
      if (firstStall === null) firstStall = event;
    };

    for (const program of this.installed) {
      const stack: Qi[] = [];
      const frames: LoopFrame[] = [];
      let pc = 0;

      const push = (value: Qi): void => {
        stack.push(Qi.of(value));
        if (stack.length > MAX_VALUE_STACK_DEPTH) {
          throw new VmError(`取值栈深 ${stack.length} 超过上限 ${MAX_VALUE_STACK_DEPTH}（pc ${pc}）`);
        }
      };
      const popOne = (label: string): Qi => {
        const value = stack.pop();
        if (value === undefined) throw new VmError(`${label} 栈下溢（pc ${pc}）`);
        return value;
      };
      const popTwo = (label: string): readonly [Qi, Qi] => {
        const right = stack.pop();
        const left = stack.pop();
        if (left === undefined || right === undefined) {
          throw new VmError(`${label} 需要 2 个操作数，栈深不足（pc ${pc}）`);
        }
        return [left, right];
      };

      run: for (;;) {
        // 预算是每 tick 的总池（契约对 budgetPool 的注释就是「每 tick 总预算」）：池被前序程序耗尽时，
        // 后续程序会在 pc 0 立刻以 reason='budget' 中止，这是共享池的必然结果，不是漏跑。
        if (steps >= this.budgetPool) {
          abort(program.id, pc, 'budget');
          break run;
        }
        if (pc === program.code.length) break;
        if (pc < 0 || pc > program.code.length) {
          throw new VmError(`pc ${pc} 越界（code.length=${program.code.length}）`);
        }
        const op = program.code[pc];
        if (op === undefined) throw new VmError(`pc ${pc} 没有指令`);

        steps += 1;
        switch (op.op) {
          case 'PUSH':
            push(op.value);
            pc += 1;
            break;
          case 'LOAD':
            push(readVar(op.key, vars, this.budgetPool - steps));
            pc += 1;
            break;
          case 'ADD': {
            const [left, right] = popTwo('ADD');
            push(Qi.add(left, right));
            pc += 1;
            break;
          }
          case 'SUB': {
            const [left, right] = popTwo('SUB');
            push(Qi.sub(left, right));
            pc += 1;
            break;
          }
          case 'MUL': {
            const [left, right] = popTwo('MUL');
            push(Qi.mul(left, right));
            pc += 1;
            break;
          }
          case 'DIV': {
            const [left, right] = popTwo('DIV');
            try {
              push(Qi.div(left, right));
            } catch {
              abort(program.id, pc, 'divZero');
              break run;
            }
            pc += 1;
            break;
          }
          case 'CMP': {
            const [left, right] = popTwo('CMP');
            push(compare(op.arg, left, right));
            pc += 1;
            break;
          }
          case 'ACTION': {
            actionSeq += 1;
            const outcome = this.sink.execute({ actionId: op.actionId, k: actionSeq, pc, loopDepth: frames.length });
            // 缺省 1 步：dispatch 前已收过这一步，这里按 sink 报的实际成本补差（契约 §2.4 的命中免步就是 -1）。
            // 回边指令（LOOP_END / JMP）不在这里改，所以 0 步的 ACTION 再密也逃不出预算检查。
            steps += (outcome.stepCost ?? 1) - 1;
            gain = Qi.add(gain, Qi.of(outcome.qi));
            demonDelta = Qi.add(demonDelta, Qi.of(outcome.demonDelta));
            pc += 1;
            break;
          }
          case 'JMP_IF_FALSE': {
            const condition = popOne('JMP_IF_FALSE');
            pc = condition === 0 ? op.target : pc + 1;
            break;
          }
          case 'JMP':
            pc = op.target;
            break;
          case 'LOOP_BEGIN': {
            // §4.2 的 count===0 表示整个循环体不执行。verifier 编译期已拒 count∉1..10，这条保底是给
            // 程序化构造 IR 的路径用的。跳 end+1 且不压帧：被跳过的 LOOP_END 是唯一弹栈点，压了就泄帧。
            if (op.count === 0) {
              pc = op.end + 1;
              break;
            }
            if (frames.length >= MAX_LOOP_DEPTH) {
              abort(program.id, pc, 'loopLimit');
              break run;
            }
            frames.push({ begin: pc, remaining: op.count });
            pc += 1;
            break;
          }
          case 'LOOP_END': {
            const frame = frames[frames.length - 1];
            if (frame === undefined) throw new VmError(`LOOP_END 处没有循环帧可弹（pc ${pc}）`);
            frame.remaining -= 1;
            if (frame.remaining > 0) {
              pc = frame.begin + 1;
            } else {
              frames.pop();
              pc += 1;
            }
            break;
          }
          case 'HALT':
            pc = program.code.length;
            break;
        }
      }
    }

    return { tick, steps, gain, demonDelta, stall: firstStall };
  }
}
