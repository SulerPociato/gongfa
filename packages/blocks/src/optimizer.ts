import { compileWorkspace, type WorkspaceJson } from './compiler';

/**
 * 炼器炉（P1 纵切：Compiler / Optimizer）。
 *
 * 它只做一件事：**找出「同一动作连续重复 N 次」的直列写法，建议改成「循环 N 次」**。
 *
 * 为什么这个改写是等价的：VM 在同一 tick 内按顺序执行动作，k 从 1 数到 N；
 * 直列 N 块与「循环 N 次包一块」产生的是同一串 actionId 序列，
 * 所以边际递减、玉简命中、心魔增长全都逐位相同（tests 里用线性化后的序列断言）。
 *
 * 代价必须一起报：IR 变短，但**每 tick 步数变多**——循环每次迭代都要执行
 * LOOP_BEGIN/LOOP_END。这正是编译器优化的经典取舍（代码体积 ↔ 运行开销），
 * 面板上两个数都写出来，不替玩家做决定。
 */
export interface RewriteSuggestion {
  /** 连续重复的动作块数（≥3 才会建议）。 */
  readonly runLength: number;
  /** 被重复的动作 id（breath / calm）。 */
  readonly actionType: string;
  readonly irBefore: number;
  readonly irAfter: number;
  /**
   * 心魔增速的倍数：循环把动作深度从 0 提到 1，吐纳的心魔增长按 (1+0.5×depth) 算 → ×1.5。
   * 调息不涨心魔（kind !== 'gain'），所以是 1。
   * 这条必须显示给玩家：**产出等价，但吐纳改写会让心魔涨得更快**。
   */
  readonly demonFactor: number;
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

function hatBody(json: WorkspaceJson): { hat: BlockJson; body: BlockJson } | null {
  const blocks = (json.blocks?.blocks ?? []) as BlockJson[];
  const hat = blocks.find((block) => block.type === 'tick_hat');
  if (hat === undefined) return null;
  const body = (hat.inputs as Record<string, { block?: BlockJson }> | undefined)?.BODY?.block;
  if (body === undefined) return null;
  return { hat, body };
}

function chainLength(json: WorkspaceJson): number {
  const compiled = compileWorkspace(json);
  return compiled.ok && compiled.program !== null ? compiled.program.code.length : 0;
}

/**
 * 扫描顶层直列链，找第一段 ≥3 个同类型动作。
 * 只处理顶层：嵌套里的改写涉及父子指针，收益一样但出错代价更高，P1 不做。
 */
export function suggestRewrite(json: WorkspaceJson): RewriteSuggestion | null {
  const body = hatBody(json);
  if (body === null) return null;

  const nodes: BlockJson[] = [];
  let cursor: BlockJson | undefined = body.body;
  while (cursor !== undefined && nodes.length < 64) {
    nodes.push(cursor);
    cursor = cursor.next?.block;
  }

  let start = -1;
  let length = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const type = nodes[i]?.type;
    if (type === undefined || !ACTION_TYPES.has(type)) continue;
    let end = i;
    while (end + 1 < nodes.length && nodes[end + 1]?.type === type) end += 1;
    if (end - i + 1 > length) {
      start = i;
      length = end - i + 1;
    }
    i = end;
  }
  if (length < 3 || start < 0) return null;

  const first = nodes[start];
  if (first?.type === undefined) return null;
  const actionType = first.type;

  // 深拷贝一份，只改这一段：其余积木（含嵌套）原样保留。
  const cloned = JSON.parse(JSON.stringify(json)) as WorkspaceJson;
  const clonedBody = hatBody(cloned);
  if (clonedBody === null) return null;

  let prev: BlockJson | null = null;
  let node: BlockJson | undefined = clonedBody.body;
  for (let i = 0; i < start && node !== undefined; i += 1) {
    prev = node;
    node = node.next?.block;
  }
  if (node === undefined) return null;

  // 在克隆链上找「这一段之后的第一个节点」，直接复用它的引用 —— 不重建对象，
  // 否则 exactOptionalPropertyTypes 会因 type/id 可能是 undefined 而报错，也容易丢字段。
  let tail: BlockJson | undefined = node;
  for (let i = 0; i < length && tail !== undefined; i += 1) tail = tail.next?.block;

  const repeat: BlockJson = {
    type: 'gongfa_repeat',
    id: `opt-repeat-${Date.now().toString(36)}`,
    fields: { NUM: length },
    inputs: { DO: { block: { type: actionType, id: `opt-act-${Date.now().toString(36)}` } } },
  };
  if (tail !== undefined) repeat.next = { block: tail };

  if (prev === null) {
    (clonedBody.hat.inputs as Record<string, unknown>).BODY = { block: repeat };
  } else {
    prev.next = { block: repeat };
  }

  const irBefore = chainLength(json);
  const irAfter = chainLength(cloned);
  if (irBefore === 0 || irAfter === 0) return null;
  // 没有真的变短就不建议：改写要是不能减少指令，就没有存在的理由。
  if (irAfter >= irBefore) return null;

  return {
    runLength: length,
    actionType,
    irBefore,
    irAfter,
    // 契约 §2.2.1：demonGrowth = base × (1 + 0.5 × loopDepth)；改写把深度 0 → 1。
    demonFactor: actionType === 'breath' ? 1.5 : 1,
    after: cloned,
  };
}
