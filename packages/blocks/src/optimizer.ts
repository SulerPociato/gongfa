import { compileWorkspace, type WorkspaceJson } from './compiler';

/**
 * 炼器炉（P1 纵切：Compiler / Optimizer）。
 *
 * 它只做一件事：**找出「同一动作连续重复 N 次」的直列写法，建议改成「循环 N 次」**。
 *
 * 为什么这个改写对**产出**是等价的：VM 在同一 tick 内按顺序执行动作，k 从 1 数到 N；
 * 直列 N 块与「循环 N 次包一块」产生的是同一串 actionId 序列，
 * 所以边际递减、玉简命中都逐位相同。
 *
 * **但心魔不等价**：循环把动作深度从 0 提到 1，而契约 §2.2.1 的
 * `demonGrowth = base × (1 + 0.5 × loopDepth)`，吐纳的心魔增速会 ×1.5
 * （调息不涨心魔，所以调息改写才是真等价）。这个代价必须显示给玩家。
 *
 * 扫描范围：整棵积木树的所有语句链（`每 tick` 本体、`如果` 的则/否则、`循环` 的体），
 * 取全局最长的一段连续同类型动作来建议 —— 嵌套里的重复同样浪费可读性。
 */
export interface RewriteSuggestion {
  /** 连续重复的动作块数（≥3 才会建议）。 */
  readonly runLength: number;
  /** 被重复的动作 id（breath / calm）。 */
  readonly actionType: string;
  readonly irBefore: number;
  readonly irAfter: number;
  /**
   * 心魔增速的倍数：循环把动作深度 +1，吐纳按 (1+0.5×depth) 计 → ×1.5；调息是 1。
   */
  readonly demonFactor: number;
  /** 这一段所在的语句链（用于面板说明，例如「循环体里」）。 */
  readonly where: string;
  /** 应用后的画布 JSON（与 before 同构，只替换那一段）。 */
  readonly after: WorkspaceJson;
}

type BlockJson = {
  type?: string;
  id?: string;
  fields?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  next?: { block?: BlockJson };
  [key: string]: unknown;
};

const ACTION_TYPES = new Set(['breath', 'calm']);
const STATEMENT_INPUTS = ['BODY', 'IF', 'ELSE', 'DO'] as const;
const MAX_NODES = 400;

interface Chain {
  readonly blocks: BlockJson[];
  /** 这一段链挂在哪：语句凹槽，或前一块的 next。 */
  readonly setFirst: (block: BlockJson) => void;
  readonly label: string;
}

function blockInput(block: BlockJson, key: string): BlockJson | undefined {
  return (block.inputs as Record<string, { block?: BlockJson }> | undefined)?.[key]?.block;
}

/** 深度优先收集所有语句链，顺序固定（决定「取哪一段」的可复现性）。 */
function collectChains(json: WorkspaceJson): Chain[] {
  const chains: Chain[] = [];
  const roots = (json.blocks?.blocks ?? []) as BlockJson[];
  const hat = roots.find((block) => block.type === 'tick_hat');
  if (hat === undefined) return chains;

  const visitBlock = (block: BlockJson, label: string): void => {
    for (const key of STATEMENT_INPUTS) {
      const first = blockInput(block, key);
      if (first === undefined) continue;
      const childLabel = key === 'BODY' ? '每 tick' : key === 'DO' ? '循环体' : key === 'IF' ? '则' : '否则';
      pushChain(block, key, first, `${label}${childLabel}`);
    }
    // 同一层的后续积木也要递归（它们各自可能带语句凹槽）
    let cursor = block.next?.block;
    while (cursor !== undefined) {
      visitBlock(cursor, label);
      cursor = cursor.next?.block;
    }
  };

  const pushChain = (holder: BlockJson, key: string, first: BlockJson, label: string): void => {
    const blocks: BlockJson[] = [];
    let cursor: BlockJson | undefined = first;
    let nodes = 0;
    while (cursor !== undefined && nodes < MAX_NODES) {
      blocks.push(cursor);
      visitBlock(cursor, `${label} › `);
      cursor = cursor.next?.block;
      nodes += 1;
    }
    chains.push({
      blocks,
      label,
      setFirst: (block) => {
        const inputs = (holder.inputs ??= {}) as Record<string, unknown>;
        inputs[key] = { block };
      },
    });
  };

  const hatBody = blockInput(hat, 'BODY');
  if (hatBody !== undefined) {
    pushChain(hat, 'BODY', hatBody, '');
    visitBlock(hat, '');
  }
  return chains;
}

function chainLength(json: WorkspaceJson): number {
  const compiled = compileWorkspace(json);
  return compiled.ok && compiled.program !== null ? compiled.program.code.length : 0;
}

export interface SuggestOptions {
  /**
   * 是否允许把直列折成「循环」。炼气期没有循环积木，
   * 折出来的块会绕过境界门控（玩家实测：炼气被建议折成循环）。
   */
  readonly allowRepeat?: boolean;
}

export function suggestRewrite(json: WorkspaceJson, options: SuggestOptions = {}): RewriteSuggestion | null {
  if (options.allowRepeat === false) return null;
  const chains = collectChains(json);
  if (chains.length === 0) return null;

  let best: { chainIndex: number; start: number; length: number; actionType: string; label: string } | null = null;
  chains.forEach((chain, chainIndex) => {
    const blocks = chain.blocks;
    for (let i = 0; i < blocks.length; i += 1) {
      const type = blocks[i]?.type;
      if (type === undefined || !ACTION_TYPES.has(type)) continue;
      let end = i;
      while (end + 1 < blocks.length && blocks[end + 1]?.type === type) end += 1;
      const length = end - i + 1;
      if (length >= 3 && (best === null || length > best.length)) {
        best = { chainIndex, start: i, length, actionType: type, label: chain.label };
      }
      i = end;
    }
  });
  if (best === null) return null;

  const target = best as { chainIndex: number; start: number; length: number; actionType: string; label: string };

  // 深拷贝后按同样的遍历顺序取同一条链，只替换那一段；其余积木（含外层循环）原样保留。
  const cloned = JSON.parse(JSON.stringify(json)) as WorkspaceJson;
  const clonedChains = collectChains(cloned);
  const chain = clonedChains[target.chainIndex];
  if (chain === undefined) return null;

  const firstInRun = chain.blocks[target.start];
  if (firstInRun === undefined) return null;
  const prev = target.start === 0 ? null : chain.blocks[target.start - 1];
  const tail = chain.blocks[target.start + target.length];

  const repeat: BlockJson = {
    type: 'gongfa_repeat',
    id: `opt-repeat-${Date.now().toString(36)}`,
    fields: { NUM: target.length },
    inputs: { DO: { block: { type: target.actionType, id: `opt-act-${Date.now().toString(36)}` } } },
  };
  if (tail !== undefined) repeat.next = { block: tail };

  if (prev === null || prev === undefined) chain.setFirst(repeat);
  else prev.next = { block: repeat };

  const irBefore = chainLength(json);
  const irAfter = chainLength(cloned);
  if (irBefore === 0 || irAfter === 0) return null;
  if (irAfter >= irBefore) return null;

  return {
    runLength: target.length,
    actionType: target.actionType,
    irBefore,
    irAfter,
    demonFactor: target.actionType === 'breath' ? 1.5 : 1,
    where: target.label,
    after: cloned,
  };
}
