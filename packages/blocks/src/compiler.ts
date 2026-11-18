import type { Op, Program } from '@gongfa/core/vm';
import { BLOCK_SPECS } from './definitions';

// Blockly 序列化 JSON 的结构类型（`Blockly.serialization.workspaces.save` 的输出）。
// 这里刻意不 import Blockly：packages/blocks 只在类型层依赖 core，Node 侧可测、浏览器无关。
export interface SerializedBlock {
  readonly type: string;
  readonly id?: string;
  readonly x?: number;
  readonly y?: number;
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
const MAX_CHAIN = 500;

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
    const body = hats[0]?.inputs?.BODY?.block;
    let current = body;
    let depth = 0;
    while (current !== undefined) {
      depth += 1;
      if (depth > MAX_CHAIN) {
        errors.push(`积木链超过 ${MAX_CHAIN} 块，已停止展开`);
        break;
      }
      const spec = BLOCK_SPECS[current.type];
      if (spec === undefined) {
        errors.push(`未知积木「${current.type}」，无法编译`);
        break;
      }
      if (spec.kind === 'action' && spec.actionId !== undefined) code.push({ op: 'ACTION', actionId: spec.actionId });
      current = current.next?.block;
    }
  }
  code.push({ op: 'HALT' });

  return { ok: errors.length === 0, program: errors.length === 0 ? { id: PROGRAM_ID, code } : null, errors, warnings };
}

function label(type: string): string {
  return BLOCK_SPECS[type]?.label ?? type;
}
