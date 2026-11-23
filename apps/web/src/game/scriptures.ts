/**
 * 藏经阁（批次 28）：主动学功法。
 *
 * 设计意图：玩家卡在「只会叠吐纳」时，缺的不是提示，是**一个能看懂的成品**。
 * 所以「学功法」= 花悟道解锁一套上乘程序，一键抄录到画布，编译后会自动点亮对应图案。
 *
 * 悟道从哪来：渡劫失败 +1（原本只是个没人看的计数）。现在它有了去处 ——
 * 输过的人学到东西，这比"失败补偿"更像修仙。
 */
export interface Scripture {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  /** 一句教学：这套东西凭什么更快。 */
  readonly teach: string;
  /** 学习成本（悟道）。 */
  readonly cost: number;
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

export const SCRIPTURES: readonly Scripture[] = [
  {
    id: 'zhouTian',
    name: '小周天',
    algorithm: '循环（for）',
    teach: '一块「吐纳」跑 5 次，和拖 5 块一样，但改次数只改一个数字。',
    cost: 1,
    workspace: () => hat(repeat('sc-r1', 5, breath('sc-b1'))),
  },
  {
    id: 'qingXin',
    name: '清心周天',
    algorithm: '循环 + 分支（反馈控制）',
    teach: '心魔超过一半才调息，否则继续吐纳：同一段代码每轮走不同的路。',
    cost: 2,
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
    id: 'huTi',
    name: '护体周天',
    algorithm: '预算守卫 + 中断',
    teach: '每一步先看预算：快撞顶就主动收手，而不是被系统掐断。',
    cost: 3,
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
    workspace: () => hat(repeat('sc-r4', 3, repeat('sc-r5', 5, breath('sc-b4')))),
  },
];

export function scriptureOf(id: string): Scripture | null {
  return SCRIPTURES.find((item) => item.id === id) ?? null;
}

export function canLearn(scripture: Scripture, insight: number, learned: readonly string[]): boolean {
  return !learned.includes(scripture.id) && insight >= scripture.cost;
}
