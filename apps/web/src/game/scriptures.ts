/**
 * 藏经阁（批次 28）：主动学功法。
 *
 * 设计意图：玩家卡在「只会叠吐纳」时，缺的不是提示，是**一个能看懂的成品**。
 * 所以「学功法」= 花悟道解锁一套上乘程序，一键抄录到画布，编译后会自动点亮对应图案。
 *
 * 2026-11-26：悟道来源扩为「失败 +1 / 首次图案 +1 / 首次试炼 +1」；新增 10 套天阶功法，
 * 0 悟道、但要先领悟指定图案（以「搭出来」换「学得到」，不抬高总价）。
 */
import type { PatternId } from '@gongfa/core';
export interface Scripture {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  /** 一句教学：这套东西凭什么更快。 */
  readonly teach: string;
  /** 学习成本（悟道）。 */
  readonly cost: number;
  /**
   * 解锁境界（0 炼气 / 1 筑基 / 2 金丹 / 3 元婴）。
   * 必须 ≥ 这套功法用到的最高级积木所要求的境界，否则会出现
   * 「炼气期抄进一个循环」——绕过境界门控，等于白送积木。
   */
  readonly realm: number;
  readonly realmName: string;
  /** basic = 花悟道；advanced = 天阶，0 悟道，但要先领悟图案。 */
  readonly tier?: 'basic' | 'advanced';
  /** 天阶功法要求先发现的图案；空/缺省 = 无门槛。 */
  readonly requires?: readonly PatternId[];
  /** 抄录时写进画布的工作区 JSON（由 builder 生成，避免共享可变对象）。 */
  readonly workspace: () => unknown;
}

const hat = (body: unknown) => ({
  blocks: {
    languageVersion: 0,
    blocks: [{ type: 'tick_hat', id: 'sc-hat', x: 40, y: 40, inputs: { BODY: { block: body } } }],
  },
});

const breath = (id: string, next?: unknown): Record<string, unknown> => ({
  type: 'breath',
  id,
  ...(next === undefined ? {} : { next: { block: next } }),
});

const calm = (id: string): Record<string, unknown> => ({ type: 'calm', id });

const chain = (blocks: readonly Record<string, unknown>[]): Record<string, unknown> => {
  let node: Record<string, unknown> | undefined;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    node = { ...blocks[i]!, ...(node === undefined ? {} : { next: { block: node } }) };
  }
  return node as Record<string, unknown>;
};

const repeat = (id: string, count: number, doBlock: unknown, next?: unknown): Record<string, unknown> => ({
  type: 'gongfa_repeat',
  id,
  fields: { NUM: count },
  inputs: { DO: { block: doBlock } },
  ...(next === undefined ? {} : { next: { block: next } }),
});

// 字段名照 definitions.ts 的 GONGFA_COMPARE_JSON：LEFT / OP / THRESHOLD。
const compare = (id: string, left: string, op: string, threshold: number): Record<string, unknown> => ({
  type: 'gongfa_compare',
  id,
  fields: { LEFT: left, OP: op, THRESHOLD: threshold },
});

const ifBlock = (id: string, condition: unknown, thenBlock: unknown, elseBlock?: unknown): Record<string, unknown> => ({
  type: 'gongfa_if',
  id,
  inputs: {
    CONDITION: { block: condition },
    IF: { block: thenBlock },
    ...(elseBlock === undefined ? {} : { ELSE: { block: elseBlock } }),
  },
});

// 阵法（批次 26）：引灵 + 阵图。阵眼数写进 RUNES 字段，编译器按 0..4 夹取。
const arrayBlock = (id: string, runes: number, next?: unknown): Record<string, unknown> => ({
  type: 'gongfa_array',
  id,
  inputs: { RUNE: { block: { type: 'gongfa_array_rune', id: `${id}-rune`, fields: { RUNES: runes } } } },
  ...(next === undefined ? {} : { next: { block: next } }),
});

// 批窗口（批次 13）：包住一段动作，把边际递减计数清零。
const batch = (id: string, doBlock: unknown): Record<string, unknown> => ({
  type: 'gongfa_batch',
  id,
  inputs: { DO: { block: doBlock } },
});

export const SCRIPTURES: readonly Scripture[] = [
  {
    id: 'straight',
    name: '直行吐纳',
    algorithm: '顺序执行（无分支）',
    teach: '六块吐纳一字排开：没有判断、没有回头，代价可预测，但一点弹性都没有。',
    cost: 1,
    realm: 0,
    realmName: '炼气',
    workspace: () =>
      hat(chain(Array.from({ length: 6 }, (_, index) => breath(`sc-straight-${index}`)))),
  },
  {
    id: 'zhouTian',
    name: '小周天',
    algorithm: '循环（for）',
    teach: '一块「吐纳」跑 5 次，和拖 5 块一样，但改次数只改一个数字。',
    cost: 1,
    realm: 1,
    realmName: '筑基',
    workspace: () => hat(repeat('sc-r1', 5, breath('sc-b1'))),
  },
  {
    id: 'jingXin',
    name: '静心诀',
    algorithm: '循环 + 先调后吐',
    teach: '每一轮先调息把心魔压下去，再吐纳；适合心魔已经高、又不想放弃产出的局面。',
    cost: 1,
    realm: 1,
    realmName: '筑基',
    workspace: () => hat(repeat('sc-rj', 5, chain([calm('sc-calmj'), breath('sc-bj')]))),
  },
  {
    id: 'array3',
    name: '三才引灵',
    algorithm: '阵法（引灵 + 阵图 3 眼）',
    teach: '引灵是查询，阵图是索引：3 眼让单次产出变成 1.35 倍，但每次要多走 3 步。',
    cost: 1,
    realm: 2,
    realmName: '金丹',
    workspace: () => hat(arrayBlock('sc-arr1', 3)),
  },
  {
    id: 'qingXin',
    name: '清心周天',
    algorithm: '循环 + 分支（反馈控制）',
    teach: '心魔超过一半才调息，否则继续吐纳：同一段代码每轮走不同的路。',
    cost: 2,
    realm: 1,
    realmName: '筑基',
    workspace: () =>
      hat(
        repeat(
          'sc-r2',
          5,
          ifBlock('sc-i1', compare('sc-c1', 'demon', '>', 0.5), calm('sc-calm1'), breath('sc-b2')),
        ),
      ),
  },
  {
    id: 'batch',
    name: '分批吐纳',
    algorithm: '批处理（沙漏重置递减）',
    teach: '同一 tick 里连做 3 次吐纳会递减；沙漏把计数清零，用 3 步启动费换第二次满额。',
    cost: 2,
    realm: 2,
    realmName: '金丹',
    workspace: () => hat(batch('sc-bat1', chain([breath('sc-bb1'), breath('sc-bb2'), breath('sc-bb3')]))),
  },
  {
    id: 'huTi',
    name: '护体周天',
    algorithm: '预算守卫 + 中断',
    teach: '每一步先看预算：快撞顶就主动收手，而不是被系统掐断。',
    cost: 3,
    realm: 2,
    realmName: '金丹',
    workspace: () =>
      hat(
        repeat(
          'sc-r3',
          10,
          ifBlock('sc-i2', compare('sc-c2', 'budget', '<', 40), { type: 'gongfa_break', id: 'sc-brk1' }, breath('sc-b3')),
        ),
      ),
  },
  {
    id: 'daZhouTian',
    name: '大小周天',
    algorithm: '嵌套循环',
    teach: '外层 3 轮、内层 5 次呼吸：总数是乘积，代价也是乘积。',
    cost: 5,
    realm: 2,
    realmName: '金丹',
    workspace: () => hat(repeat('sc-r4', 3, repeat('sc-r5', 5, breath('sc-b4')))),
  },
  // ---- 天阶（2026-11-26）：0 悟道，先领悟对应图案 ----
  {
    id: 'binaryBreath',
    name: '二分吐纳',
    algorithm: '二分 + 分支',
    teach: '先看存量在哪一档，再决定跑 5 次还是 10 次：用一次判断换掉一半的固定开销。',
    cost: 0,
    tier: 'advanced',
    requires: ['feedback'],
    realm: 1,
    realmName: '筑基',
    workspace: () => hat(ifBlock('sc-bin-i', compare('sc-bin-c', 'qi', '>', 500), repeat('sc-bin-r1', 5, breath('sc-bin-b1')), repeat('sc-bin-r2', 10, breath('sc-bin-b2')))),
  },
  {
    id: 'cacheWarm',
    name: '缓存预热',
    algorithm: '缓存 + 循环',
    teach: '先把同一动作连续跑热，再让后续执行吃到缓存：预热不是白跑，是把冷启动挪到前面。',
    cost: 0,
    tier: 'advanced',
    requires: ['loop'],
    realm: 1,
    realmName: '筑基',
    workspace: () => hat(repeat('sc-cw-r', 3, chain([breath('sc-cw-b1'), breath('sc-cw-b2')]))),
  },
  {
    id: 'pipeline',
    name: '流水线',
    algorithm: '流水线 / 批处理',
    teach: '吐纳、调息、吐纳排成一条线：每一段只做一件事，但整条线一直在动。',
    cost: 0,
    tier: 'advanced',
    requires: ['linear', 'loop'],
    realm: 1,
    realmName: '筑基',
    workspace: () => hat(repeat('sc-pl-r', 5, chain([breath('sc-pl-b1'), calm('sc-pl-c1'), breath('sc-pl-b2')]))),
  },
  {
    id: 'circuitBreak',
    name: '熔断诀',
    algorithm: '熔断器',
    teach: '心魔一过线就切到调息，等它降下来再恢复：坏的时候先保命，不硬扛。',
    cost: 0,
    tier: 'advanced',
    requires: ['feedback', 'guard'],
    realm: 2,
    realmName: '金丹',
    workspace: () => hat(repeat('sc-cb-r', 10, ifBlock('sc-cb-i', compare('sc-cb-c', 'demon', '>', 0.5), calm('sc-cb-calm'), breath('sc-cb-b')))),
  },
  {
    id: 'backoff',
    name: '退避重试',
    algorithm: '退避 + 预算守卫',
    teach: '预算快见底就先调息让一步，下一轮再试：不退避的重试只会把预算撞穿。',
    cost: 0,
    tier: 'advanced',
    requires: ['prune'],
    realm: 2,
    realmName: '金丹',
    workspace: () => hat(repeat('sc-bo-r', 5, ifBlock('sc-bo-i', compare('sc-bo-c', 'budget', '<', 40), calm('sc-bo-calm'), breath('sc-bo-b')))),
  },
  {
    id: 'rateLimit',
    name: '限流器',
    algorithm: '限流 + 中断',
    teach: '预算不够就主动收手，而不是等系统截断：被截断的那一 tick 连半成品都不算。',
    cost: 0,
    tier: 'advanced',
    requires: ['prune', 'break'],
    realm: 2,
    realmName: '金丹',
    workspace: () => hat(repeat('sc-rl-r', 10, ifBlock('sc-rl-i', compare('sc-rl-c', 'budget', '<', 30), { type: 'gongfa_break', id: 'sc-rl-brk' }, breath('sc-rl-b')))),
  },
  {
    id: 'eventLoop',
    name: '事件循环',
    algorithm: '事件循环 + 提前退出',
    teach: '存量够了就跳出，不再空转：事件循环的价值是「该停的时候停」。',
    cost: 0,
    tier: 'advanced',
    requires: ['break', 'loop'],
    realm: 2,
    realmName: '金丹',
    workspace: () => hat(repeat('sc-ev-r', 10, ifBlock('sc-ev-i', compare('sc-ev-c', 'qi', '>', 1000), { type: 'gongfa_break', id: 'sc-ev-brk' }, breath('sc-ev-b')))),
  },
  {
    id: 'divideConquer',
    name: '分治周天',
    algorithm: '分治（嵌套循环）',
    teach: '大周天拆成 2 段，每段 5 次：问题变小，代价也变小，但总账一样。',
    cost: 0,
    tier: 'advanced',
    requires: ['nested'],
    realm: 2,
    realmName: '金丹',
    workspace: () => hat(repeat('sc-dc-r1', 2, repeat('sc-dc-r2', 5, breath('sc-dc-b')))),
  },
  {
    id: 'mapReduce',
    name: '归并吐纳',
    algorithm: 'MapReduce + 批处理',
    teach: '每个 map 跑一批，再 reduce 成总产出：批内重新计第一次，批间付启动费。',
    cost: 0,
    tier: 'advanced',
    requires: ['batch'],
    realm: 2,
    realmName: '金丹',
    workspace: () => hat(repeat('sc-mr-r', 2, batch('sc-mr-bat', chain([breath('sc-mr-b1'), breath('sc-mr-b2'), breath('sc-mr-b3')])))),
  },
  {
    id: 'bloomFilter',
    name: '布隆过滤',
    algorithm: '概率判断 + 分支',
    teach: '心魔高时先判「可能危险」，直接调息；宁可多压一次，也不赌它刚好不炸。',
    cost: 0,
    tier: 'advanced',
    requires: ['feedback'],
    realm: 1,
    realmName: '筑基',
    workspace: () => hat(ifBlock('sc-bf-i', compare('sc-bf-c', 'demon', '>', 0.7), calm('sc-bf-calm'), chain([breath('sc-bf-b1'), breath('sc-bf-b2')]))),
  },
];

export function scriptureOf(id: string): Scripture | null {
  return SCRIPTURES.find((item) => item.id === id) ?? null;
}

export function canLearn(
  scripture: Scripture,
  insight: number,
  learned: readonly string[],
  realmIndex: number,
  foundPatterns: readonly PatternId[] = [],
): boolean {
  if (learned.includes(scripture.id)) return false;
  if (realmIndex < scripture.realm) return false;
  if (missingPatterns(scripture, foundPatterns).length > 0) return false;
  return insight >= scripture.cost;
}

/** 天阶功法还缺哪些图案（基础功法返回空数组）。 */
export function missingPatterns(scripture: Scripture, foundPatterns: readonly PatternId[]): readonly PatternId[] {
  const required = scripture.requires ?? [];
  return required.filter((id) => !foundPatterns.includes(id));
}

/** 抄录前的最后一道闸：模板里用到的积木，当前境界必须都给得出来。 */
export function missingBlocks(scripture: Scripture, available: readonly string[]): readonly string[] {
  return missingBlocksIn(scripture.workspace(), available);
}

/** 通用版：任意 Blockly workspace JSON 里用到的积木，有多少是当前境界给不出的。 */
export function missingBlocksIn(workspace: unknown, available: readonly string[]): readonly string[] {
  const availableSet = new Set(available);
  const used = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.type === 'string') used.add(record.type);
    for (const value of Object.values(record)) walk(value);
  };
  walk(workspace);
  used.delete('tick_hat');
  return [...used].filter((type) => !availableSet.has(type));
}
