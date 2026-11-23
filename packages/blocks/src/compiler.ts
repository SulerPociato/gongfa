import type { Op, Program } from '@gongfa/core/vm';
import { BATCH_START_COST, BLOCK_SPECS } from './definitions';

// Blockly 序列化 JSON 的结构类型（`Blockly.serialization.workspaces.save` 的输出）。
// 这里刻意不 import Blockly：packages/blocks 只在类型层依赖 core，Node 侧可测、浏览器无关。
export interface SerializedBlock {
  readonly type: string;
  readonly id?: string;
  readonly x?: number;
  readonly y?: number;
  /** field_number 存成 number、field_dropdown 存成 string，两种都要吃。 */
  readonly fields?: Record<string, string | number | undefined> | undefined;
  readonly inputs?: Record<string, { readonly block?: SerializedBlock | undefined } | undefined>;
  readonly next?: { readonly block?: SerializedBlock | undefined } | undefined;
}

export interface WorkspaceJson {
  readonly blocks?:
    | {
        readonly languageVersion?: number;
        readonly blocks?: readonly SerializedBlock[] | undefined;
      }
    | undefined;
}

export interface CompileResult {
  readonly ok: boolean;
  readonly program: Program | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export const PROGRAM_ID = 'gongfa';

// 链长上限只是防呆：真正的指令数上限由 core 的 verifier 按契约 §4.4 判。
const MAX_BLOCK = 500;

// 「比较」积木允许的左值（IR 的 LOAD 还支持 rate / realm，P0 不暴露给玩家）。
const COMPARE_KEYS = ['qi', 'demon', 'budget'] as const;

interface Emitter {
  readonly code: Op[];
  readonly errors: string[];
  readonly warnings: string[];
  blocks: number;
  // 循环上下文栈：break/continue 编译时查栈顶，决定 JMP 目标。repeat 和 while 都压帧。
  loopStack: LoopCtx[];
}

interface LoopCtx {
  kind: 'repeat' | 'while';
  // continue 的 JMP 目标：repeat → LOOP_BEGIN pc（编译期已知）；while → WHILE_END pc（需回填）。
  continueTarget: number;
  // while 循环里 continue 的 JMP 占位下标，WHILE_END 发射后统一回填。
  continuePatchSlots: number[];
  // 循环出口参照：repeat → LOOP_END pc；while → WHILE_EXIT pc。break 用 BREAK op（VM 弹帧跳 exit+1），
  // 这里只存参照地址供编译器校验，实际 BREAK 指令不带 target。
  exitRef: number;
}

export function compileWorkspace(json: WorkspaceJson): CompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const roots = json.blocks?.blocks ?? [];
  const hats = roots.filter((block) => BLOCK_SPECS[block.type]?.kind === 'entry');

  for (const root of roots) {
    if (BLOCK_SPECS[root.type] === undefined) errors.push(`未知积木「${root.type}」，无法编译`);
    else if (root.type !== 'tick_hat') warnings.push(`孤立方块「${label(root.type)}」没有接进「每 tick」，本 tick 不执行`);
  }
  if (hats.length === 0) errors.push('缺少「每 tick」入口块：功法不会执行');
  if (hats.length > 1) errors.push(`「每 tick」入口块有 ${hats.length} 个，契约 §4.4 只允许一个`);

  const code: Op[] = [];
  if (hats.length === 1) {
    const emitter: Emitter = { code, errors, warnings, blocks: 0, loopStack: [] };
    emitSequence(emitter, hats[0]?.inputs?.BODY?.block);
  }
  code.push({ op: 'HALT' });

  return { ok: errors.length === 0, program: errors.length === 0 ? { id: PROGRAM_ID, code } : null, errors, warnings };
}

function label(type: string): string {
  return BLOCK_SPECS[type]?.label ?? type;
}

// 语句序列：Blockly 把第一个块放在 input.block，后续兄弟挂在 next.block。
function emitSequence(emitter: Emitter, first: SerializedBlock | undefined): void {
  let current = first;
  while (current !== undefined) {
    emitter.blocks += 1;
    if (emitter.blocks > MAX_BLOCK) {
      emitter.errors.push(`积木数量超过 ${MAX_BLOCK} 块，已停止展开`);
      return;
    }
    emitStatement(emitter, current);
    current = current.next?.block;
  }
}

function emitStatement(emitter: Emitter, block: SerializedBlock): void {
  const spec = BLOCK_SPECS[block.type];
  if (spec === undefined) {
    emitter.errors.push(`未知积木「${block.type}」，无法编译`);
    return;
  }
  switch (spec.kind) {
    case 'action':
      if (spec.actionId !== undefined) emitter.code.push({ op: 'ACTION', actionId: spec.actionId });
      return;
    case 'control':
      emitControl(emitter, block);
      return;
    case 'value':
      emitter.errors.push(`「${spec.label}」只能接在「如果」的条件位，不能放进语句序列`);
      return;
    case 'entry':
      emitter.errors.push(`「${spec.label}」入口块不能嵌在别的积木里`);
      return;
  }
}

function emitControl(emitter: Emitter, block: SerializedBlock): void {
  switch (block.type) {
    case 'gongfa_if':
      emitIf(emitter, block);
      return;
    case 'gongfa_repeat':
      emitRepeat(emitter, block);
      return;
    case 'gongfa_while':
      emitWhile(emitter, block);
      return;
    case 'gongfa_break':
      emitBreak(emitter);
      return;
    case 'gongfa_continue':
      emitContinue(emitter);
      return;
    case 'gongfa_batch':
      emitBatch(emitter, block);
      return;
    default:
      emitter.errors.push(`控件「${label(block.type)}」没有编译规则`);
  }
}

/**
 * 沙漏（批次 13 / P1）：批窗口起点。
 * 发射 BATCH_BEGIN（付固定步数 + 重置边际递减计数），再展开批内动作。
 * 批内不需要结束标记：`k` 由 VM 的 actionSeq 控制，下一次 BATCH_BEGIN 自然会再清零。
 */
function emitBatch(emitter: Emitter, block: SerializedBlock): void {
  const body = block.inputs?.DO?.block;
  if (body === undefined) {
    emitter.errors.push('「沙漏」是空的：把要攒成一批的动作放进去');
    return;
  }
  emitter.code.push({ op: 'BATCH_BEGIN', steps: BATCH_START_COST });
  emitSequence(emitter, body);
}

// 如果 → JMP_IF_FALSE 占位，分支发射完再回补跳转目标（契约 §4.1）。
function emitIf(emitter: Emitter, block: SerializedBlock): void {
  const cond = block.inputs?.CONDITION?.block;
  if (cond === undefined) {
    emitter.errors.push('「如果」缺少条件：请把「比较」积木接进条件位');
    return;
  }
  emitCondition(emitter, cond);

  const jumpToElse = emitter.code.length;
  emitter.code.push({ op: 'JMP_IF_FALSE', target: -1 });

  const then = block.inputs?.IF?.block;
  if (then === undefined) emitter.warnings.push('「如果」的「则」分支为空');
  emitSequence(emitter, then);

  const otherwise = block.inputs?.ELSE?.block;
  if (otherwise === undefined) {
    emitter.code[jumpToElse] = { op: 'JMP_IF_FALSE', target: emitter.code.length };
    return;
  }
  const jumpToEnd = emitter.code.length;
  emitter.code.push({ op: 'JMP', target: -1 });
  emitter.code[jumpToElse] = { op: 'JMP_IF_FALSE', target: emitter.code.length };
  emitSequence(emitter, otherwise);
  emitter.code[jumpToEnd] = { op: 'JMP', target: emitter.code.length };
}

function emitCondition(emitter: Emitter, cond: SerializedBlock): void {
  const spec = BLOCK_SPECS[cond.type];
  if (spec?.kind !== 'value') {
    emitter.errors.push(`「如果」的条件必须是「比较」积木，收到「${cond.type}」`);
    return;
  }
  emitCompare(emitter, cond);
}

function emitCompare(emitter: Emitter, block: SerializedBlock): void {
  const fields = block.fields ?? {};
  const rawKey = fields.LEFT;
  const key = COMPARE_KEYS.find((allowed) => allowed === rawKey);
  if (key === undefined) {
    emitter.errors.push(`「比较」的左值「${String(rawKey)}」不在允许清单（存量 / 心魔 / 预算）`);
    return;
  }
  const cmp = fields.OP;
  if (cmp !== '>' && cmp !== '<') {
    emitter.errors.push(`「比较」的运算符「${String(cmp)}」不支持，只实现 > 与 <`);
    return;
  }
  const threshold = toNumber(fields.THRESHOLD);
  if (threshold === null) {
    emitter.errors.push(`「比较」的阈值不是数字，收到「${String(fields.THRESHOLD)}」`);
    return;
  }
  emitter.code.push({ op: 'LOAD', key }, { op: 'PUSH', value: threshold }, { op: 'CMP', arg: cmp });
}

function emitRepeat(emitter: Emitter, block: SerializedBlock): void {
  const raw = block.fields?.NUM;
  const count = toNumber(raw);
  if (count === null || !Number.isInteger(count) || count < 1 || count > 10) {
    emitter.errors.push(`「循环」次数必须是 1–10，收到 ${String(raw)}`);
    return;
  }
  const body = block.inputs?.DO?.block;
  if (body === undefined) {
    emitter.errors.push('「循环」的循环体为空');
    return;
  }
  const begin = emitter.code.length;
  emitter.code.push({ op: 'LOOP_BEGIN', end: -1, count });
  // 压循环上下文：continue → JMP{LOOP_END pc}（跳过剩余 body，让 LOOP_END 处理回跳/退出）
  // continueTarget 先占位 -1，LOOP_END 发射后再回填。
  emitter.loopStack.push({ kind: 'repeat', continueTarget: -1, continuePatchSlots: [], exitRef: -1 });
  emitSequence(emitter, body);
  const end = emitter.code.length;
  emitter.code.push({ op: 'LOOP_END', begin });
  emitter.code[begin] = { op: 'LOOP_BEGIN', end, count };
  // 回填 continue JMP 的目标（LOOP_END 的 pc）
  const ctx = emitter.loopStack.pop();
  if (ctx !== undefined) {
    ctx.continueTarget = end;
    ctx.exitRef = end;
    for (const slot of ctx.continuePatchSlots) {
      emitter.code[slot] = { op: 'JMP', target: end };
    }
  }
}

// 批次 5：重复直到（while）。条件在循环顶部求值，WHILE_BEGIN/END/EXIT 三 op 结构。
// 语义：当 CONDITION 为真时执行 DO，为假时跳出。和 Blockly 的 "repeat until" 相反——
// 那里是"直到条件为真才停"，这里是"条件为真才继续"。名字沿用用户习惯的"重复直到"。
function emitWhile(emitter: Emitter, block: SerializedBlock): void {
  const cond = block.inputs?.CONDITION?.block;
  if (cond === undefined) {
    emitter.errors.push('「重复直到」缺少条件：请把「比较」积木接进条件位');
    return;
  }
  const body = block.inputs?.DO?.block;
  if (body === undefined) {
    emitter.errors.push('「重复直到」的循环体为空');
    return;
  }
  const beginPc = emitter.code.length;
  emitter.code.push({ op: 'WHILE_BEGIN' });
  // 条件求值：条件为真时继续（JMP_IF_FALSE 不跳），为假时跳出（跳到 WHILE_EXIT）
  emitCondition(emitter, cond);
  const jumpToExit = emitter.code.length;
  emitter.code.push({ op: 'JMP_IF_FALSE', target: -1 });
  // 压循环上下文：continue → JMP{whileEndPc}（稍后回填）；break → BREAK op
  emitter.loopStack.push({ kind: 'while', continueTarget: -1, continuePatchSlots: [], exitRef: -1 });
  emitSequence(emitter, body);
  const whileEndPc = emitter.code.length;
  // WHILE_END.begin = WHILE_BEGIN + 1（verifier 要求 begin 指向条件首条指令，VM 跳到这里重判条件）
  emitter.code.push({ op: 'WHILE_END', begin: beginPc + 1 });
  // 回填所有 continue JMP 的目标
  const ctx = emitter.loopStack.pop();
  if (ctx !== undefined) {
    for (const slot of ctx.continuePatchSlots) {
      emitter.code[slot] = { op: 'JMP', target: whileEndPc };
    }
    ctx.exitRef = whileEndPc + 2; // WHILE_EXIT 在 WHILE_END+1
  }
  const exitPc = emitter.code.length;
  emitter.code.push({ op: 'WHILE_EXIT' });
  // 回填 JMP_IF_FALSE 目标
  emitter.code[jumpToExit] = { op: 'JMP_IF_FALSE', target: exitPc };
  if (ctx !== undefined) ctx.exitRef = exitPc;
}

// BREAK：编译为 BREAK op（不是 JMP）。VM 执行时弹最内层帧并跳到循环出口之后。
// 不在循环内时 emitter.loopStack 为空，报错。
function emitBreak(emitter: Emitter): void {
  if (emitter.loopStack.length === 0) {
    emitter.errors.push('「中断」必须在循环内使用');
    return;
  }
  emitter.code.push({ op: 'BREAK' });
}

// CONTINUE：编译为 JMP 到 continueTarget。repeat → LOOP_END pc（需回填）；
// while → WHILE_END pc（需回填）。两种都要先占位再记录 slot。
function emitContinue(emitter: Emitter): void {
  if (emitter.loopStack.length === 0) {
    emitter.errors.push('「继续」必须在循环内使用');
    return;
  }
  const ctx = emitter.loopStack[emitter.loopStack.length - 1];
  if (ctx === undefined) return;
  // repeat 和 while 都需要回填：continueTarget 在循环体发射完后才知道
  const slot = emitter.code.length;
  emitter.code.push({ op: 'JMP', target: -1 }); // 占位
  ctx.continuePatchSlots.push(slot);
}

// Blockly 的 field_number 在 JSON 里是 number，手写产物可能是 string，空串一律当缺字段。
function toNumber(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
