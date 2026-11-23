import type { Content } from '../content/schema';
import {
  branchTarget,
  CMP_ARGS,
  jumpTarget,
  LOAD_KEYS,
  LOOP_COUNT_MAX,
  LOOP_COUNT_MIN,
  MAX_LOOP_DEPTH,
  MAX_STATIC_INSTRUCTIONS,
  MAX_VALUE_STACK_DEPTH,
  OP_TAGS,
  type CmpArg,
  type LoadKey,
  type Op,
  type OpTag,
  type Program,
} from './program';

export type VerifyCheck =
  | 'entry'
  | 'instruction-count'
  | 'type'
  | 'jump-target'
  | 'loop-pair'
  | 'loop-count'
  | 'stack-depth'
  | 'action-id'
  | 'div-zero'
  | 'while-pair'
  | 'while-body'
  | 'break';

export interface VerifyIssue {
  readonly check: VerifyCheck;
  readonly pc: number;
  readonly message: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly errors: readonly VerifyIssue[];
  readonly warnings: readonly string[];
}

interface Sink {
  add(check: VerifyCheck, pc: number, message: string): void;
}

type Slot = number | 'unknown';

interface WalkState {
  readonly pc: number;
  readonly stack: readonly Slot[];
  readonly frames: number;
}

const MAX_ANALYSIS_STATES = 5000;

export function verifyProgram(program: Program, content: Content): VerifyResult {
  const errors: VerifyIssue[] = [];
  const warnings: string[] = [];
  const sink: Sink = {
    add(check, pc, message) {
      errors.push({ check, pc, message });
    },
  };
  const code = program.code;

  if (code.length === 0) {
    sink.add('entry', 0, '指令流为空：入口块缺失，程序无法执行');
    return freeze(errors, warnings);
  }
  if (code.length > MAX_STATIC_INSTRUCTIONS) {
    sink.add('instruction-count', 0, `静态指令数 ${code.length} 超过上限 ${MAX_STATIC_INSTRUCTIONS}`);
  }

  const actionIds = new Set(content.actions.map((action) => action.id));
  for (const [pc, raw] of code.entries()) {
    inspectOp(pc, raw, sink);
    const tag = opTag(raw);
    if (tag === null) continue;

    if (tag === 'ACTION') {
      const actionId = field(raw, 'actionId');
      if (typeof actionId === 'string' && !actionIds.has(actionId)) {
        sink.add('action-id', pc, `actionId "${actionId}" 不在 actions.json 中`);
      }
    }
    const target = jumpTarget(raw as Op);
    if (target !== null && (target < 0 || target >= code.length)) {
      sink.add('jump-target', pc, `跳转目标 ${target} 越界（有效区间 0..${code.length - 1}）`);
    }
    const entry = branchTarget(raw as Op);
    if (entry === 0) {
      sink.add('entry', pc, `pc ${pc} 跳回入口 0，破坏单入口约定`);
    }
    if (tag === 'LOOP_BEGIN') {
      const count = field(raw, 'count');
      if (typeof count === 'number' && Number.isInteger(count) && (count < LOOP_COUNT_MIN || count > LOOP_COUNT_MAX)) {
        sink.add('loop-count', pc, `LOOP_BEGIN.count=${count} 超出编译期允许区间 ${LOOP_COUNT_MIN}..${LOOP_COUNT_MAX}`);
      }
    }
  }

  checkLoopPairs(code, sink);
  checkWhilePairs(code, sink);
  checkBreakInLoop(code, sink);
  const reachable = walkStackModel(program, sink, warnings);
  markUnreachable(code, reachable, warnings);

  return freeze(errors, warnings);
}

function freeze(errors: readonly VerifyIssue[], warnings: readonly string[]): VerifyResult {
  return { ok: errors.length === 0, errors, warnings };
}

function opTag(raw: unknown): OpTag | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const tag = (raw as { op: unknown }).op;
  return typeof tag === 'string' && OP_TAGS.includes(tag as OpTag) ? (tag as OpTag) : null;
}

function field(raw: unknown, name: string): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined;
  return (raw as Record<string, unknown>)[name];
}

function asIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asConstant(value: unknown): number | 'unknown' {
  return typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
}

// 契约 §4.4 的“类型”行在 P0 只有 number 一档，落为指令操作数自身的合法性；栈下溢归 stack-depth。
function inspectOp(pc: number, raw: unknown, sink: Sink): void {
  if (typeof raw !== 'object' || raw === null) {
    sink.add('type', pc, `指令不是对象，收到 ${JSON.stringify(raw)}`);
    return;
  }
  const tag = opTag(raw);
  if (tag === null) {
    sink.add('type', pc, `未知指令 op=${JSON.stringify(field(raw, 'op'))}，契约 §4.1 只允许 ${OP_TAGS.join(' | ')}`);
    return;
  }

  switch (tag) {
    case 'PUSH': {
      const value = field(raw, 'value');
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        sink.add('type', pc, `PUSH.value 需要有限数字，收到 ${JSON.stringify(value)}`);
      }
      break;
    }
    case 'LOAD': {
      const key = field(raw, 'key');
      if (typeof key !== 'string' || !LOAD_KEYS.includes(key as LoadKey)) {
        sink.add('type', pc, `LOAD.key 需要 ${LOAD_KEYS.join(' | ')}，收到 ${JSON.stringify(key)}`);
      }
      break;
    }
    case 'CMP': {
      const arg = field(raw, 'arg');
      if (typeof arg !== 'string' || !CMP_ARGS.includes(arg as CmpArg)) {
        sink.add('type', pc, `CMP.arg 需要 ${CMP_ARGS.join(' | ')}，收到 ${JSON.stringify(arg)}`);
      }
      break;
    }
    case 'ACTION': {
      const actionId = field(raw, 'actionId');
      if (typeof actionId !== 'string' || actionId.trim() === '') {
        sink.add('type', pc, `ACTION.actionId 需要非空字符串，收到 ${JSON.stringify(actionId)}`);
      }
      break;
    }
    case 'JMP':
    case 'JMP_IF_FALSE':
    case 'LOOP_END':
    case 'LOOP_BEGIN': {
      const targetName = tag === 'LOOP_BEGIN' ? 'end' : tag === 'LOOP_END' ? 'begin' : 'target';
      if (asIndex(field(raw, targetName)) === null) {
        sink.add('type', pc, `${tag}.${targetName} 需要整数，收到 ${JSON.stringify(field(raw, targetName))}`);
      }
      if (tag === 'LOOP_BEGIN' && asIndex(field(raw, 'count')) === null) {
        sink.add('type', pc, `LOOP_BEGIN.count 需要整数，收到 ${JSON.stringify(field(raw, 'count'))}`);
      }
      break;
    }
    case 'WHILE_END': {
      if (asIndex(field(raw, 'begin')) === null) {
        sink.add('type', pc, `WHILE_END.begin 需要整数，收到 ${JSON.stringify(field(raw, 'begin'))}`);
      }
      break;
    }
    case 'WHILE_BEGIN':
    case 'WHILE_EXIT': {
      break;
    }
    case 'ADD':
    case 'SUB':
    case 'MUL':
    case 'DIV':
    case 'BREAK':
    case 'HALT':
      break;
  }
}

function checkLoopPairs(code: readonly unknown[], sink: Sink): void {
  const claimedEnd = new Map<number, number>();

  for (const [pc, raw] of code.entries()) {
    if (opTag(raw) !== 'LOOP_BEGIN') continue;
    const end = asIndex(field(raw, 'end'));
    if (end === null || asIndex(field(raw, 'count')) === null) continue;
    if (end <= pc) {
      sink.add('loop-pair', pc, `LOOP_BEGIN 的 end=${end} 必须位于自身之后`);
      continue;
    }
    if (end >= code.length) continue;
    const endRaw = code[end];
    if (opTag(endRaw) !== 'LOOP_END') {
      sink.add('loop-pair', pc, `LOOP_BEGIN 的 end=${end} 处不是 LOOP_END`);
      continue;
    }
    if (asIndex(field(endRaw, 'begin')) !== pc) {
      sink.add('loop-pair', pc, `LOOP_BEGIN@${pc} 与 LOOP_END@${end} 未互相指回`);
      continue;
    }
    claimedEnd.set(end, pc);
  }

  for (const [pc, raw] of code.entries()) {
    if (opTag(raw) !== 'LOOP_END') continue;
    if (!claimedEnd.has(pc)) {
      sink.add('loop-pair', pc, `LOOP_END@${pc} 没有被任何 LOOP_BEGIN 认领`);
    }
  }

  const ranges = [...claimedEnd.entries()]
    .map(([end, begin]) => ({ begin, end }))
    .sort((a, b) => a.begin - b.begin);
  for (const [i, outer] of ranges.entries()) {
    for (const inner of ranges.slice(i + 1)) {
      if (outer.begin < inner.begin && inner.begin < outer.end && outer.end < inner.end) {
        sink.add('loop-pair', inner.begin, `循环区间 [${inner.begin},${inner.end}] 与 [${outer.begin},${outer.end}] 交叉嵌套`);
      }
    }
  }
}

// 批次 5：WHILE 成对检查 + 非空体检查。
// WHILE_BEGIN 入栈，WHILE_EXIT 出栈；WHILE_END.begin 必须指向本层 WHILE_BEGIN+1。
// WHILE_EXIT 必须紧跟 WHILE_END（exit === end+1）。
function checkWhilePairs(code: readonly unknown[], sink: Sink): void {
  const whileStack: number[] = [];
  const claimedWhileExit = new Set<number>();

  for (const [pc, raw] of code.entries()) {
    const tag = opTag(raw);
    if (tag === 'WHILE_BEGIN') {
      whileStack.push(pc);
    } else if (tag === 'WHILE_END') {
      const begin = asIndex(field(raw, 'begin'));
      if (begin === null) continue;
      if (whileStack.length === 0) {
        sink.add('while-pair', pc, `WHILE_END@${pc} 没有配对的 WHILE_BEGIN`);
        continue;
      }
      const whileBeginPc = whileStack[whileStack.length - 1];
      if (whileBeginPc === undefined) continue;
      if (begin !== whileBeginPc + 1) {
        sink.add('while-pair', pc, `WHILE_END.begin=${begin} 必须等于 WHILE_BEGIN@${whileBeginPc}+1=${whileBeginPc + 1}`);
      }
      // WHILE_EXIT 必须紧跟 WHILE_END
      const exitPc = pc + 1;
      if (exitPc >= code.length) {
        sink.add('while-pair', pc, `WHILE_END@${pc} 之后缺少 WHILE_EXIT`);
        continue;
      }
      const exitRaw = code[exitPc];
      if (opTag(exitRaw) !== 'WHILE_EXIT') {
        sink.add('while-pair', pc, `WHILE_END@${pc} 之后必须是 WHILE_EXIT，收到 ${opTag(exitRaw)}`);
        continue;
      }
      claimedWhileExit.add(exitPc);
      whileStack.pop();
    } else if (tag === 'WHILE_EXIT') {
      if (!claimedWhileExit.has(pc)) {
        sink.add('while-pair', pc, `WHILE_EXIT@${pc} 没有被任何 WHILE_END 认领`);
      }
    }
  }

  if (whileStack.length > 0) {
    for (const beginPc of whileStack) {
      sink.add('while-pair', beginPc, `WHILE_BEGIN@${beginPc} 没有配对的 WHILE_END/WHILE_EXIT`);
    }
  }

  // 非空体检查：WHILE_BEGIN 与 WHILE_END 之间至少一条 ACTION 或 LOOP_BEGIN
  for (const [pc, raw] of code.entries()) {
    if (opTag(raw) !== 'WHILE_BEGIN') continue;
    let hasActionOrLoop = false;
    for (let i = pc + 1; i < code.length; i++) {
      const innerTag = opTag(code[i]);
      if (innerTag === 'WHILE_END') break;
      if (innerTag === 'ACTION' || innerTag === 'LOOP_BEGIN') {
        hasActionOrLoop = true;
        break;
      }
    }
    if (!hasActionOrLoop) {
      sink.add('while-body', pc, `WHILE_BEGIN@${pc} 体为空：至少需要一条 ACTION 或 LOOP_BEGIN`);
    }
  }
}

// BREAK 必须在循环内：用循环深度计数器扫一遍，深度为 0 处遇到 BREAK 即报错。
function checkBreakInLoop(code: readonly unknown[], sink: Sink): void {
  let depth = 0;
  for (const [pc, raw] of code.entries()) {
    const tag = opTag(raw);
    if (tag === 'LOOP_BEGIN' || tag === 'WHILE_BEGIN') depth += 1;
    else if (tag === 'LOOP_END' || tag === 'WHILE_EXIT') depth -= 1;
    else if (tag === 'BREAK' && depth === 0) {
      sink.add('break', pc, 'BREAK 不在任何循环内');
    }
  }
}

function slotText(slot: Slot): string {
  return slot === 'unknown' ? 'u' : String(slot);
}

function stackKey(state: WalkState): string {
  return `${state.pc}|${state.frames}|${state.stack.map(slotText).join(',')}`;
}

function topTwo(stack: readonly Slot[]): readonly [Slot, Slot] | null {
  const right = stack[stack.length - 1];
  const left = stack[stack.length - 2];
  return left === undefined || right === undefined ? null : [left, right];
}

function foldBinary(op: 'ADD' | 'SUB' | 'MUL' | 'DIV', left: Slot, right: Slot): Slot {
  if (typeof left !== 'number' || typeof right !== 'number') return 'unknown';
  switch (op) {
    case 'ADD':
      return left + right;
    case 'SUB':
      return left - right;
    case 'MUL':
      return left * right;
    case 'DIV':
      return right === 0 ? 'unknown' : left / right;
  }
}

function foldCompare(arg: CmpArg, left: Slot, right: Slot): Slot {
  if (typeof left !== 'number' || typeof right !== 'number') return 'unknown';
  if (arg === '<') return left < right ? 1 : 0;
  if (arg === '>') return left > right ? 1 : 0;
  return left === right ? 1 : 0;
}

function cmpArgOf(value: unknown): CmpArg {
  return value === '<' || value === '>' || value === '==' ? value : '==';
}

// 契约 §4.4：静态模拟栈深始终 ≥0 且 ≤16，兼查常量除零与循环帧数；分支与回边都走，靠状态集收敛。
function walkStackModel(program: Program, sink: Sink, warnings: string[]): Set<number> {
  const code = program.code;
  const reachable = new Set<number>();
  const visited = new Set<string>();
  const reported = new Set<string>();
  const queue: WalkState[] = [{ pc: 0, stack: [], frames: 0 }];
  let truncated = false;

  const report = (check: VerifyCheck, pc: number, message: string): void => {
    const key = `${check}@${pc}`;
    if (reported.has(key)) return;
    reported.add(key);
    sink.add(check, pc, message);
  };

  while (queue.length > 0) {
    const state = queue.shift();
    if (state === undefined) break;
    if (visited.size >= MAX_ANALYSIS_STATES) {
      truncated = true;
      break;
    }
    const key = stackKey(state);
    if (visited.has(key)) continue;
    visited.add(key);

    if (state.pc < 0) {
      report('jump-target', state.pc, `跳转到负地址 ${state.pc}`);
      continue;
    }
    reachable.add(state.pc);
    if (state.pc >= code.length) continue;

    const raw = code[state.pc];
    const tag = opTag(raw);
    if (tag === null) continue;

    const next = (pc: number, stack: readonly Slot[], frames: number): void => {
      if (stack.length > MAX_VALUE_STACK_DEPTH) {
        report('stack-depth', pc, `取值栈深 ${stack.length} 超过上限 ${MAX_VALUE_STACK_DEPTH}`);
        return;
      }
      if (frames > MAX_LOOP_DEPTH) {
        report('stack-depth', pc, `循环帧 ${frames} 超过上限 ${MAX_LOOP_DEPTH}`);
        return;
      }
      queue.push({ pc, stack, frames });
    };
    const requireTwo = (): readonly [Slot, Slot] | null => {
      const operands = topTwo(state.stack);
      if (operands === null) {
        report('stack-depth', state.pc, `${tag} 需要 2 个操作数，栈深只有 ${state.stack.length}`);
      }
      return operands;
    };

    switch (tag) {
      case 'PUSH':
        next(state.pc + 1, [...state.stack, asConstant(field(raw, 'value'))], state.frames);
        break;
      case 'LOAD':
        next(state.pc + 1, [...state.stack, 'unknown'], state.frames);
        break;
      case 'ADD':
      case 'SUB':
      case 'MUL':
      case 'DIV': {
        const operands = requireTwo();
        if (operands === null) break;
        const [left, right] = operands;
        if (tag === 'DIV' && right === 0) {
          report('div-zero', state.pc, 'DIV 的右操作数为常量 0，拒绝编译');
          break;
        }
        next(state.pc + 1, [...state.stack.slice(0, -2), foldBinary(tag, left, right)], state.frames);
        break;
      }
      case 'CMP': {
        const operands = requireTwo();
        if (operands === null) break;
        const [left, right] = operands;
        const folded = foldCompare(cmpArgOf(field(raw, 'arg')), left, right);
        next(state.pc + 1, [...state.stack.slice(0, -2), folded], state.frames);
        break;
      }
      case 'ACTION':
        next(state.pc + 1, state.stack, state.frames);
        break;
      case 'JMP': {
        const target = asIndex(field(raw, 'target'));
        if (target !== null) next(target, state.stack, state.frames);
        break;
      }
      case 'JMP_IF_FALSE': {
        const target = asIndex(field(raw, 'target'));
        const condition = state.stack[state.stack.length - 1];
        if (condition === undefined) {
          report('stack-depth', state.pc, 'JMP_IF_FALSE 需要 1 个操作数，栈是空的');
          break;
        }
        const rest = state.stack.slice(0, -1);
        if (typeof condition === 'number') {
          if (condition !== 0) {
            next(state.pc + 1, rest, state.frames);
          } else if (target !== null) {
            next(target, rest, state.frames);
          }
        } else {
          if (target !== null) next(target, rest, state.frames);
          next(state.pc + 1, rest, state.frames);
        }
        break;
      }
      case 'LOOP_BEGIN': {
        const end = asIndex(field(raw, 'end'));
        const count = asIndex(field(raw, 'count'));
        // 与运行时同口径：count===0 落到 end+1，循环体不执行也不压帧（count∉1..10 另有 loop-count 报错）。
        if (count === 0 && end !== null) {
          next(end + 1, state.stack, state.frames);
          break;
        }
        next(state.pc + 1, state.stack, state.frames + 1);
        break;
      }
      case 'LOOP_END': {
        if (state.frames === 0) {
          report('stack-depth', state.pc, 'LOOP_END 处没有循环帧可弹');
          break;
        }
        const begin = asIndex(field(raw, 'begin'));
        if (begin !== null) next(begin + 1, state.stack, state.frames);
        next(state.pc + 1, state.stack, state.frames - 1);
        break;
      }
      // BREAK 弹帧并跳出循环：静态分析里这条路径到此终止，不需要推后续状态。
      case 'BREAK': {
        if (state.frames === 0) {
          report('stack-depth', state.pc, 'BREAK 处没有循环帧可弹');
        }
        break;
      }
      case 'HALT':
        break;
    }
  }

  if (truncated) {
    warnings.push(`静态分析在 ${MAX_ANALYSIS_STATES} 个状态处截断，栈深结论可能不完整`);
  }
  return reachable;
}

function markUnreachable(code: readonly unknown[], reachable: Set<number>, warnings: string[]): void {
  const orphanPcs: number[] = [];
  for (let pc = 0; pc < code.length; pc++) {
    if (!reachable.has(pc)) orphanPcs.push(pc);
  }
  if (orphanPcs.length > 0) {
    warnings.push(`pc ${orphanPcs.join(', ')} 静态不可达（孤立方块？）`);
  }
}
