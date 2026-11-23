export type LoadKey = 'qi' | 'rate' | 'demon' | 'realm' | 'budget';

export type CmpArg = '<' | '>' | '==';

// 契约 §4.1 指令集，逐字实现：无 CALL、无 eval。
export type Op =
  | { op: 'PUSH'; value: number }
  | { op: 'LOAD'; key: LoadKey }
  | { op: 'ADD' }
  | { op: 'SUB' }
  | { op: 'MUL' }
  | { op: 'DIV' }
  | { op: 'CMP'; arg: CmpArg }
  | { op: 'ACTION'; actionId: string; runes?: number }
  | { op: 'JMP_IF_FALSE'; target: number }
  | { op: 'JMP'; target: number }
  | { op: 'LOOP_BEGIN'; end: number; count: number }
  | { op: 'LOOP_END'; begin: number }
  | { op: 'WHILE_BEGIN' }
  | { op: 'WHILE_END'; begin: number }
  | { op: 'WHILE_EXIT' }
  /**
   * 批次 13（P1 沙漏）：批窗口起点。
   * 语义：付 `steps` 步固定开销，把「同 tick 内同一动作的边际递减计数」清零 ——
   * 下一次 ACTION 重新从 k=1 算。这是微批处理（micro-batching）的代价模型：
   * 批越大，摊薄得越划算；批与批之间要重新付启动成本。
   */
  | { op: 'BATCH_BEGIN'; steps: number }
  | { op: 'BREAK' }
  | { op: 'HALT' };

export type OpTag = Op['op'];

export const OP_TAGS: readonly OpTag[] = [
  'PUSH',
  'LOAD',
  'ADD',
  'SUB',
  'MUL',
  'DIV',
  'CMP',
  'ACTION',
  'JMP_IF_FALSE',
  'JMP',
  'LOOP_BEGIN',
  'LOOP_END',
  'WHILE_BEGIN',
  'WHILE_END',
  'WHILE_EXIT',
  'BATCH_BEGIN',
  'BREAK',
  'HALT',
];

export const LOAD_KEYS: readonly LoadKey[] = ['qi', 'rate', 'demon', 'realm', 'budget'];

export const CMP_ARGS: readonly CmpArg[] = ['<', '>', '=='];

export interface Program {
  readonly id: string;
  readonly code: readonly Op[];
}

// 契约 §4.4：静态指令数上限。
export const MAX_STATIC_INSTRUCTIONS = 500;
// 契约 §4.2：循环嵌套的运行期帧栈上限。
export const MAX_LOOP_DEPTH = 16;
// 契约 §4.4：静态模拟的取值栈上限。
export const MAX_VALUE_STACK_DEPTH = 16;
// 契约 §4.2：count 编译期限定 1–10。
export const LOOP_COUNT_MIN = 1;
export const LOOP_COUNT_MAX = 10;

export function staticInstructionCount(program: Program): number {
  return program.code.length;
}

export function jumpTarget(op: Op): number | null {
  switch (op.op) {
    case 'JMP':
    case 'JMP_IF_FALSE':
      return op.target;
    case 'LOOP_BEGIN':
      return op.end;
    case 'LOOP_END':
      return op.begin;
    case 'WHILE_END':
      return op.begin;
    default:
      return null;
  }
}

// 只有 JMP / JMP_IF_FALSE 才算控制流入口候选；LOOP_END 的 begin 指回 LOOP_BEGIN 是合法回边。
export function branchTarget(op: Op): number | null {
  switch (op.op) {
    case 'JMP':
    case 'JMP_IF_FALSE':
      return op.target;
    default:
      return null;
  }
}
