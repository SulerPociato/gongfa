/**
 * 阵法阁（2026-11-26）：4 套免费阵法预设，**只追加、不替换**。
 *
 * 玩家原话：「阵法能不能也有预设的，能直接叠加在我现有功法上；
 * 注意阵法代码块不会直接对我的引灵代码块造成影响，所以拓印阵法时不要替换我现有的引灵代码块。」
 *
 * 所以 merge 的语义只有一条：找到「每 tick」的 BODY 链尾，把预设块链接在 next 上；
 * 现有块（尤其已有的引灵）一个都不删、不改、不重写。测试会深比较原引灵块。
 */
export interface FormationPreset {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  readonly teach: string;
  /** 解锁境界（0 炼气 / 1 筑基 / 2 金丹 / 3 元婴）。 */
  readonly realm: number;
  readonly realmName: string;
  /** 生成要追加的块链；id 由 mergeFormation 提供，保证与现有 id 不撞。 */
  readonly build: (id: (base: string) => string) => Record<string, unknown>;
}

const arrayBlock = (id: string, runes: number, next?: unknown): Record<string, unknown> => ({
  type: 'gongfa_array',
  id,
  inputs: { RUNE: { block: { type: 'gongfa_array_rune', id: `${id}-rune`, fields: { RUNES: runes } } } },
  ...(next === undefined ? {} : { next: { block: next } }),
});

const repeat = (id: string, count: number, doBlock: unknown): Record<string, unknown> => ({
  type: 'gongfa_repeat',
  id,
  fields: { NUM: count },
  inputs: { DO: { block: doBlock } },
});

const batch = (id: string, doBlock: unknown): Record<string, unknown> => ({
  type: 'gongfa_batch',
  id,
  inputs: { DO: { block: doBlock } },
});

const calm = (id: string): Record<string, unknown> => ({ type: 'calm', id });

const chain = (blocks: readonly Record<string, unknown>[]): Record<string, unknown> => {
  let node: Record<string, unknown> | undefined;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    node = { ...blocks[i]!, ...(node === undefined ? {} : { next: { block: node } }) };
  }
  return node as Record<string, unknown>;
};

export const FORMATIONS: readonly FormationPreset[] = [
  {
    id: 'threeTalents',
    name: '三才引灵阵',
    algorithm: '阵法（3 眼）',
    teach: '一次引灵带 3 枚阵眼：单次产出 ×1.35，但每次要走 4 步。追加在现有功法末尾，不替换你已有的引灵。',
    realm: 2,
    realmName: '金丹',
    build: (id) => arrayBlock(id('array'), 3),
  },
  {
    id: 'zhouTianArray',
    name: '周天引灵阵',
    algorithm: '阵法 + 循环',
    teach: '循环 5 次、每次引灵 2 眼：把阵法的单次增益摊到多次执行上。',
    realm: 2,
    realmName: '金丹',
    build: (id) => repeat(id('repeat'), 5, arrayBlock(id('array'), 2)),
  },
  {
    id: 'fourSymbols',
    name: '四象护体阵',
    algorithm: '阵法 4 眼 + 调息',
    teach: '引灵拉满 4 眼，再补一次调息压心魔：高产出和高心魔一起来，得自己配刹车。',
    realm: 2,
    realmName: '金丹',
    build: (id) => chain([arrayBlock(id('array'), 4), calm(id('calm'))]),
  },
  {
    id: 'microBatch',
    name: '微批引灵阵',
    algorithm: '阵法 + 批处理',
    teach: '沙漏把两次引灵的边际递减清零：第二块引灵不再打 8 折，代价是每批多 4 步。',
    realm: 2,
    realmName: '金丹',
    build: (id) => batch(id('batch'), chain([arrayBlock(id('array'), 2), arrayBlock(id('array'), 2)])),
  },
  // ---- 元婴天阶（2026-11-26）：更重的阵法，仍然只追加 ----
  {
    id: 'swordArray',
    name: '玄天剑阵',
    algorithm: '阵法 + 循环（流水线）',
    teach: '循环 3 次、每次 4 眼引灵：把高单次增益摊成一条持续输出的剑阵。',
    realm: 3,
    realmName: '元婴',
    build: (id) => repeat(id('repeat'), 3, arrayBlock(id('array'), 4)),
  },
  {
    id: 'asuraArray',
    name: '十二凶煞阵',
    algorithm: '阵法 + 批处理（背压）',
    teach: '一批里塞 3 块 3 眼引灵：批内重新计第一次，代价是每批固定启动费。',
    realm: 3,
    realmName: '元婴',
    build: (id) => batch(id('batch'), chain([arrayBlock(id('array'), 3), arrayBlock(id('array'), 3), arrayBlock(id('array'), 3)])),
  },
  {
    id: 'beastArray',
    name: '四灵群妖阵',
    algorithm: '阵法 + 调息（限流）',
    teach: '循环 4 次：每次 2 眼引灵后补一次调息，产出与心魔一起管。',
    realm: 3,
    realmName: '元婴',
    build: (id) => repeat(id('repeat'), 4, chain([arrayBlock(id('array'), 2), calm(id('calm'))])),
  },
  {
    id: 'lockArray',
    name: '天罡锁灵阵',
    algorithm: '阵法 + 互斥（锁）',
    teach: '两次 3 眼引灵中间夹一次调息：像加锁一样，一段高产出后必须先让出一次。',
    realm: 3,
    realmName: '元婴',
    build: (id) => chain([arrayBlock(id('array'), 3), calm(id('calm')), arrayBlock(id('array'), 3)]),
  },
];

export function formationOf(id: string): FormationPreset | null {
  return FORMATIONS.find((item) => item.id === id) ?? null;
}

export interface MergeResult {
  readonly workspace: unknown;
  readonly appended: number;
  readonly kept: number;
  readonly arraysBefore: number;
  readonly arraysAfter: number;
}

function countBlocks(node: unknown, type: string): number {
  if (typeof node !== 'object' || node === null) return 0;
  const record = node as Record<string, unknown>;
  let count = record.type === type ? 1 : 0;
  for (const value of Object.values(record)) count += countBlocks(value, type);
  return count;
}

function collectIds(node: unknown, ids: Set<string>): void {
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  if (typeof record.id === 'string') ids.add(record.id);
  for (const value of Object.values(record)) collectIds(value, ids);
}

function countAllBlocks(node: unknown): number {
  if (typeof node !== 'object' || node === null) return 0;
  const record = node as Record<string, unknown>;
  let count = typeof record.type === 'string' ? 1 : 0;
  for (const value of Object.values(record)) count += countAllBlocks(value);
  return count;
}

const EMPTY_WORKSPACE = (): Record<string, unknown> => ({ blocks: { languageVersion: 0, blocks: [] } });

/**
 * 把预设追加到当前功法末尾。
 * 返回值的 arraysBefore/After 给确认框用；测试用它们证明「没有替换」。
 */
export function mergeFormation(current: unknown, preset: FormationPreset): MergeResult {
  const workspace = (typeof current === 'object' && current !== null
    ? JSON.parse(JSON.stringify(current))
    : EMPTY_WORKSPACE()) as Record<string, unknown>;
  const blocksRoot = (typeof workspace.blocks === 'object' && workspace.blocks !== null
    ? workspace.blocks
    : { languageVersion: 0, blocks: [] }) as Record<string, unknown>;
  if (!Array.isArray(blocksRoot.blocks)) blocksRoot.blocks = [];
  workspace.blocks = blocksRoot;
  const top = blocksRoot.blocks as Record<string, unknown>[];

  const arraysBefore = countBlocks(workspace, 'gongfa_array');
  const kept = countAllBlocks(workspace);
  const ids = new Set<string>();
  collectIds(workspace, ids);
  const nextId = (base: string): string => {
    let index = 1;
    while (ids.has(`form-${base}-${index}`)) index += 1;
    const id = `form-${base}-${index}`;
    ids.add(id);
    return id;
  };
  const appendedBlock = preset.build(nextId);

  let hat = top.find((block) => block.type === 'tick_hat');
  if (hat === undefined) {
    hat = { type: 'tick_hat', id: nextId('hat'), x: 40, y: 40 };
    top.push(hat);
  }
  const inputs = (typeof hat.inputs === 'object' && hat.inputs !== null ? hat.inputs : {}) as Record<string, unknown>;
  hat.inputs = inputs;
  const bodySlot = inputs.BODY as { block?: Record<string, unknown> } | undefined;
  if (bodySlot === undefined || typeof bodySlot.block !== 'object' || bodySlot.block === null) {
    inputs.BODY = { block: appendedBlock };
  } else {
    let tail: Record<string, unknown> = bodySlot.block;
    while (typeof tail.next === 'object' && tail.next !== null) {
      const nextBlock = (tail.next as { block?: Record<string, unknown> }).block;
      if (typeof nextBlock !== 'object' || nextBlock === null) break;
      tail = nextBlock;
    }
    tail.next = { block: appendedBlock };
  }

  return {
    workspace,
    appended: countAllBlocks(appendedBlock),
    kept,
    arraysBefore,
    arraysAfter: countBlocks(workspace, 'gongfa_array'),
  };
}
