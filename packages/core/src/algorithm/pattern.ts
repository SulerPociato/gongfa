import { BACKLASH_LINE } from '../demon/rules';
import type { CmpArg, LoadKey, Op } from '../vm/program';

// 批次 3：算法识别（任务 8 续）。
// 判据只读结构快照，不启动 VM、不跑 tickProfile —— 玩家拖出来的积木序列就是真相，
// 展开后的 kinds 会把「则分支里的动作」丢掉（profile.ts 的 jmp 一律走 false 路径），
// 用它判反馈控制等于把整条 then-branch 抹掉，判据就错了。

export type PatternId = 'linear' | 'loop' | 'feedback' | 'cache' | 'break' | 'while' | 'adaptive';

/**
 * 谱的分母从这张表来，不写死 4：表里加一行新图案，HUD 的「功法谱 N/4」自动变 N/5，
 * 集齐 toast 也按这张表的长度触发，不用回头改代码。
 */
export interface PatternDef {
  readonly id: PatternId;
  /** 卡片与抽屉里出现的中文名（「恭喜你发现了「周天循环」」）。 */
  readonly name: string;
  /** 卡片第二句的算法术语（「这就是计算机里的 for 循环」）。 */
  readonly algorithm: string;
  /** 抽屉里未发现的「缺什么」提示，由宿主拼成一句完整的「需要……」 */
  readonly requires: string;
}

export const PATTERNS: readonly PatternDef[] = [
  { id: 'linear', name: '直行吐纳', algorithm: '顺序执行', requires: '一块「吐纳」放进「每 tick」' },
  { id: 'loop', name: '周天循环', algorithm: 'for 循环', requires: '「循环」里放「吐纳」' },
  { id: 'feedback', name: '清心诀', algorithm: '反馈控制', requires: '「如果 心魔 > x」里放「调息」' },
  { id: 'cache', name: '玉简缓存', algorithm: '缓存命中', requires: '循环跑两遍以上 + 装备玉简' },
  { id: 'break', name: '见好就收', algorithm: '提前退出（early exit / 剪枝）', requires: '循环里放「中断」' },
  { id: 'while', name: '不定周天', algorithm: '条件循环（while）', requires: '「重复直到」里放动作' },
  { id: 'adaptive', name: '自适应周天', algorithm: '分支预测 / 自适应迭代', requires: '「循环」里放一个「如果」' },
];

export const PATTERN_TOTAL = PATTERNS.length;

export function patternDef(id: PatternId): PatternDef {
  const def = PATTERNS.find((pattern) => pattern.id === id);
  if (def === undefined) throw new RangeError(`unknown pattern id: ${String(id)}`);
  return def;
}

/**
 * 结构快照：判据的全部输入。
 * - actions：程序里所有 ACTION 指令，按出现顺序（含循环体、分支体内的）。
 * - loops：每个 LOOP_BEGIN 的区间与循环次数；depth = 外层嵌套数（顶层 0）。
 * - branches：每个 JMP_IF_FALSE 的条件与两个分支的动作清单；at = 指令下标。
 * - equipped：宿主注入的装备位（artifact id），cache 判据要读它。
 *
 * 快照与 VM 状态解耦：同一份 code 永远产出同一份 shape，所以识别结果可缓存、可落盘。
 */
export interface ProgramShape {
  readonly actions: readonly string[];
  readonly loops: readonly LoopRange[];
  readonly branches: readonly BranchRange[];
  readonly equipped: readonly string[];
}

export interface LoopRange {
  readonly begin: number;
  readonly end: number;
  /** repeat 的循环次数；while 没有静态次数，记 0。 */
  readonly count: number;
  readonly depth: number;
  /** 这一层循环体里的动作 id（按出现顺序）。 */
  readonly actionIds: readonly string[];
  /** 循环体里是否含 JMP_IF_FALSE（反馈控制嵌在循环里也算「有分支」）。 */
  readonly hasBranch: boolean;
  /** 循环体里是否含 BREAK（提前退出）。 */
  readonly hasBreak: boolean;
  /** 是否为 while 循环（WHILE_BEGIN 产生）。 */
  readonly isWhile: boolean;
}

export interface BranchRange {
  /** JMP_IF_FALSE 在 code 里的下标：用于判「某分支是否落在某个循环体内」。 */
  readonly at: number;
  readonly key: LoadKey;
  readonly cmp: CmpArg;
  readonly threshold: number;
  readonly thenIds: readonly string[];
  readonly elseIds: readonly string[];
}

/**
 * 单趟扫描 code 出快照。
 * 循环区间用栈维护：LOOP_BEGIN/WHILE_BEGIN 压栈、LOOP_END/WHILE_EXIT 弹栈，depth = 栈长 − 1。
 * 分支区间靠 JMP_IF_FALSE 的 target 直接定位 then-body 的右端；
 * 若 then-body 末尾是 JMP（有 else），else-body 的右端就是那个 JMP 的 target。
 * BREAK 和跳出循环的 JMP 标记最内层循环的 hasBreak。
 */
export function shapeOf(code: readonly Op[], equipped: readonly string[]): ProgramShape {
  const actions: string[] = [];
  const branches: BranchRange[] = [];
  // 统一循环栈：repeat 和 while 共用，靠 isWhile 区分。
  const loopStack: { begin: number; depth: number; isWhile: boolean; endPc: number }[] = [];
  const loopBodies: Map<number, string[]> = new Map();
  const loopBranches: Map<number, boolean> = new Map();
  const loopBreaks: Map<number, boolean> = new Map();
  const loopRanges: { begin: number; end: number; count: number; depth: number; isWhile: boolean }[] = [];

  // WHILE 的「出口在哪」必须提前算：WHILE_BEGIN 自己不携带 exit，
  // 而 JMP 判定"是否跳出本层"要用它。第一版把 endPc 留在 -1，导致 while 体内
  // 任何 JMP（包括普通 if-else 的尾部跳转）都被当成 BREAK —— 评审实测
  // 「重复直到 + 继续」被判成 ['loop','break','while']。这里先配对再扫描。
  const whileExitByBegin = new Map<number, number>();
  {
    const stack: number[] = [];
    for (let i = 0; i < code.length; i += 1) {
      const op = code[i];
      if (op === undefined) continue;
      if (op.op === 'WHILE_BEGIN') stack.push(i);
      else if (op.op === 'WHILE_EXIT') {
        const begin = stack.pop();
        if (begin !== undefined) whileExitByBegin.set(begin, i);
      }
    }
  }

  for (let index = 0; index < code.length; index += 1) {
    const op = code[index];
    if (op === undefined) continue;
    switch (op.op) {
      case 'ACTION': {
        actions.push(op.actionId);
        for (const entry of loopStack) {
          const body = loopBodies.get(entry.begin);
          if (body !== undefined) body.push(op.actionId);
        }
        break;
      }
      case 'LOOP_BEGIN': {
        const depth = loopStack.length;
        loopStack.push({ begin: index, depth, isWhile: false, endPc: op.end });
        loopBodies.set(index, []);
        loopBranches.set(index, false);
        loopBreaks.set(index, false);
        break;
      }
      case 'LOOP_END': {
        const top = loopStack.pop();
        if (top === undefined) break;
        const beginOp = code[top.begin];
        const count = beginOp !== undefined && beginOp.op === 'LOOP_BEGIN' ? beginOp.count : 0;
        loopRanges.push({ begin: top.begin, end: index + 1, count, depth: top.depth, isWhile: false });
        break;
      }
      case 'WHILE_BEGIN': {
        const depth = loopStack.length;
        // 配对表在第一遍扫描里建好，这里直接取；取不到才退回 -1（坏 IR 由 verifier 先拦）。
        loopStack.push({ begin: index, depth, isWhile: true, endPc: whileExitByBegin.get(index) ?? -1 });
        loopBodies.set(index, []);
        loopBranches.set(index, false);
        loopBreaks.set(index, false);
        break;
      }
      case 'WHILE_EXIT': {
        // 找栈顶的 WHILE_BEGIN（应该是最后一个 isWhile=true 的）
        const top = loopStack.pop();
        if (top === undefined) break;
        loopRanges.push({ begin: top.begin, end: index + 1, count: 0, depth: top.depth, isWhile: true });
        break;
      }
      case 'BREAK': {
        // BREAK 在最内层循环里 → 标记 hasBreak
        const innermost = loopStack[loopStack.length - 1];
        if (innermost !== undefined) loopBreaks.set(innermost.begin, true);
        break;
      }
      case 'JMP': {
        // 检查是否为 break（跳出最内层循环）：target > 最内层循环的 endPc
        const innermost = loopStack[loopStack.length - 1];
        if (innermost !== undefined && op.target > innermost.endPc) {
          loopBreaks.set(innermost.begin, true);
        }
        break;
      }
      case 'JMP_IF_FALSE': {
        const condition = readCondition(code, index);
        if (condition === null) break;
        const thenStart = index + 1;
        const thenEnd = op.target;
        const thenIds = collectActions(code, thenStart, thenEnd);
        let elseIds: readonly string[] = [];
        const jumpOpIndex = thenEnd - 1;
        const jumpOp = code[jumpOpIndex];
        if (jumpOpIndex >= thenStart && jumpOp !== undefined && jumpOp.op === 'JMP') {
          elseIds = collectActions(code, thenEnd, jumpOp.target);
        }
        branches.push({ at: index, ...condition, thenIds, elseIds });
        for (const entry of loopStack) {
          const loopEnd = entry.endPc;
          // while 自己的条件跳转（目标正好是本层 WHILE_EXIT）不算"循环体里有分支"：
          // 编译器的重复直到永远发这一条，算进去的话每个 while 都会被判成 adaptive（评审指出的误判）。
          const isOwnWhileCondition = entry.isWhile && op.target === loopEnd;
          if (isOwnWhileCondition) continue;
          if (index > entry.begin && index < loopEnd) {
            loopBranches.set(entry.begin, true);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const loops: LoopRange[] = loopRanges.map((range) => ({
    ...range,
    actionIds: loopBodies.get(range.begin) ?? [],
    hasBranch: loopBranches.get(range.begin) ?? false,
    hasBreak: loopBreaks.get(range.begin) ?? false,
  }));

  return { actions, loops, branches, equipped };
}

/**
 * 读 JMP_IF_FALSE 之前的三条指令：LOAD / PUSH / CMP。
 * 编译器（emitCompare）固定按这个顺序发，所以回看 3 格即可；不匹配就放弃这条分支（判据不成立）。
 */
function readCondition(code: readonly Op[], jmpIndex: number): Pick<BranchRange, 'key' | 'cmp' | 'threshold'> | null {
  const cmp = code[jmpIndex - 1];
  const push = code[jmpIndex - 2];
  const load = code[jmpIndex - 3];
  if (cmp === undefined || push === undefined || load === undefined) return null;
  if (cmp.op !== 'CMP' || push.op !== 'PUSH' || load.op !== 'LOAD') return null;
  return { key: load.key, cmp: cmp.arg, threshold: push.value };
}

function collectActions(code: readonly Op[], from: number, to: number): string[] {
  const ids: string[] = [];
  for (let index = from; index < to && index < code.length; index += 1) {
    const op = code[index];
    if (op !== undefined && op.op === 'ACTION') ids.push(op.actionId);
  }
  return ids;
}

/**
 * 从结构快照推当前程序命中的图案集合。
 * 同一份代码可同时命中多个图案（例如「循环里套清心诀」= loop ∩ feedback），
 * 返回集合由宿主决定一次弹一张卡还是合并展示。
 */
export function patternsOf(shape: ProgramShape): readonly PatternId[] {
  const hits: PatternId[] = [];
  if (matchesLinear(shape)) hits.push('linear');
  if (matchesLoop(shape)) hits.push('loop');
  if (matchesFeedback(shape)) hits.push('feedback');
  if (matchesCache(shape)) hits.push('cache');
  if (matchesBreak(shape)) hits.push('break');
  if (matchesWhile(shape)) hits.push('while');
  if (matchesAdaptive(shape)) hits.push('adaptive');
  return hits;
}

/**
 * linear：程序里没有任何控制流，且只有一个动作、那个动作是吐纳。
 * 多一块吐纳都不算（边际递减的课还没上）；有循环/分支就更不算。
 */
function matchesLinear(shape: ProgramShape): boolean {
  return shape.loops.length === 0
    && shape.branches.length === 0
    && shape.actions.length === 1
    && (shape.actions[0] ?? '') === 'breath';
}

/**
 * loop：存在至少一个循环，循环体里全是吐纳、没有分支。
 * 嵌套循环只要最内层满足也算（「周天循环」的语义是「一圈一圈跑」，层数不重要）。
 */
function matchesLoop(shape: ProgramShape): boolean {
  return shape.loops.some((loop) => loop.actionIds.length > 0 && loop.actionIds.every((id) => id === 'breath') && !loop.hasBranch);
}

/**
 * feedback：存在「如果 心魔 > x」且则分支里有调息。
 * 阈值必须 < BACKLASH_LINE：≥ 1 的条件永远不成立，那是死代码不是反馈。
 * 比较方向必须是 >：心魔「涨过」某条线才压，< 的话是「心魔低于 x 才压」，反了。
 */
function matchesFeedback(shape: ProgramShape): boolean {
  return shape.branches.some(
    (branch) => branch.key === 'demon'
      && branch.cmp === '>'
      && branch.threshold < BACKLASH_LINE
      && branch.threshold > 0
      && branch.thenIds.includes('calm'),
  );
}

/**
 * cache：循环跑至少 2 次（单次循环没有「第二次命中」可言）且装备了玉简。
 * 不查循环体里是什么：玉简的缓存命中跟动作种类无关，跟「同一 tick 内重跑」有关。
 */
function matchesCache(shape: ProgramShape): boolean {
  const hasLoop = shape.loops.some((loop) => loop.count >= 2 && loop.actionIds.length > 0);
  return hasLoop && shape.equipped.includes('jade');
}

/**
 * break：存在至少一个循环体内含 BREAK 或跳出该循环的 JMP（hasBreak 标记）。
 * 「见好就收」的语义是「条件满足就提前退出」，所以循环里得有 break 才算。
 */
function matchesBreak(shape: ProgramShape): boolean {
  return shape.loops.some((loop) => loop.hasBreak);
}

/**
 * while：存在至少一个 WHILE 循环（count === 0 && isWhile === true）。
 * 「不定周天」的语义是「不确定跑多少圈，看条件」，和固定次数的 repeat 区分。
 */
function matchesWhile(shape: ProgramShape): boolean {
  return shape.loops.some((loop) => loop.isWhile);
}

/**
 * adaptive：固定次数的循环里还有分支 —— 每一圈是否走「则」由条件决定，不是死板地跑 N 遍。
 *
 * 判据刻意排除 while：编译器的「重复直到」永远自带一条条件跳转，
 * 不排除的话每个 while 都会被顺带判成 adaptive（评审实测过的误判）。
 * hasBranch 在 shapeOf 里已经剔掉了 while 自己的条件跳，这里再要求 !isWhile 是双保险。
 */
function matchesAdaptive(shape: ProgramShape): boolean {
  return shape.loops.some((loop) => !loop.isWhile && loop.hasBranch);
}
