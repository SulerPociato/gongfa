import { describe, expect, it } from 'vitest';
import realArtifacts from '../../../../content/artifacts.json';
import { ContentValidationError } from './schema';
import { equipArtifacts, loadArtifacts, type ArtifactDef } from './artifacts';

// 与 books.test.ts 同风格：坏表用内联字面量，真表另外单独钉一条，防止 JSON 与契约 §2.4 走偏。
const JADE = {
  id: 'jade',
  name: { zh: '玉简' },
  effects: [{ type: 'cache', cache: { sameActionId: true, hitGainMultiplier: 0.7, hitStepCost: 0 } }],
};
const ABACUS = {
  id: 'abacus',
  name: { zh: '算盘' },
  effects: [{ type: 'modifier', modifier: { id: 'abacus_budget', target: 'budget', kind: 'add', value: 50 } }],
};

function artifacts(raw: readonly unknown[]): readonly ArtifactDef[] {
  return loadArtifacts(raw);
}

function expectErrors(raw: unknown, fragment: string): string {
  try {
    loadArtifacts(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ContentValidationError);
    const message = (error as ContentValidationError).errors.join('\n');
    expect(message).toContain(fragment);
    return message;
  }
  throw new Error(`坏表没有被拒：${fragment}`);
}

describe('道具表（契约 §2.4，任务 7A）', () => {
  it('content/artifacts.json 逐值钉住：玉简 ×0.7 计 0 步，算盘预算 +50', () => {
    const loaded = loadArtifacts(realArtifacts);
    expect(loaded.map((artifact) => artifact.id)).toEqual(['jade', 'abacus', 'pearl', 'vase', 'pouch']);
    const jade = loaded[0]!.effects[0];
    expect(jade).toEqual({ type: 'cache', cache: { sameActionId: true, hitGainMultiplier: 0.7, hitStepCost: 0 } });
    const abacus = loaded[1]!.effects[0];
    expect(abacus).toEqual({ type: 'modifier', modifier: { id: 'abacus_budget', target: 'budget', kind: 'add', value: 50 } });
  });

  it('空表、非数组、非对象行都拒', () => {
    expectErrors([], '非空数组');
    expectErrors({}, '非空数组');
    expectErrors([null], '[0]: 需要对象');
  });

  it('重复 id 拒：装备位按 id 认，重复会让卸下少删一条', () => {
    expectErrors([JADE, JADE], 'id 重复: jade');
  });

  it('未知 effect type 与缺 cache / modifier 主体都拒', () => {
    expectErrors([{ ...JADE, effects: [{ type: 'aura', cache: { sameActionId: true, hitGainMultiplier: 0.7, hitStepCost: 0 } }] }], 'effects[0].type');
    expectErrors([{ ...JADE, effects: [{ type: 'cache' }] }], 'effects[0].cache');
    expectErrors([{ ...ABACUS, effects: [{ type: 'modifier' }] }], 'effects[0].modifier');
    expectErrors([{ ...JADE, effects: [] }], 'effects: 需要非空数组');
  });

  it('缓存数值：hitGainMultiplier 需要 [0,1] 的有限数，hitStepCost 需要非负整数，sameActionId 只认真', () => {
    const cacheAt = (cache: unknown): string => expectErrors([{ id: 'j', name: { zh: '玉简' }, effects: [{ type: 'cache', cache }] }], 'effects[0].cache');
    cacheAt({ sameActionId: true, hitGainMultiplier: Number.NaN, hitStepCost: 0 });
    cacheAt({ sameActionId: true, hitGainMultiplier: -0.7, hitStepCost: 0 });
    cacheAt({ sameActionId: true, hitGainMultiplier: 1.5, hitStepCost: 0 });
    cacheAt({ sameActionId: true, hitGainMultiplier: 0.7, hitStepCost: 0.5 });
    cacheAt({ sameActionId: true, hitGainMultiplier: 0.7, hitStepCost: -1 });
    cacheAt({ sameActionId: false, hitGainMultiplier: 0.7, hitStepCost: 0 });
    cacheAt({ hitGainMultiplier: 0.7, hitStepCost: 0 });
  });

  it('budget 类 modifier：只认 add 且需要非负整数，mul 与负数一律坏表', () => {
    const modifierAt = (modifier: unknown): string =>
      expectErrors([{ id: 'a', name: { zh: '算盘' }, effects: [{ type: 'modifier', modifier }] }], 'effects[0].modifier');
    modifierAt({ id: 'm', target: 'budget', kind: 'mul', value: 1.25 });
    modifierAt({ id: 'm', target: 'budget', kind: 'add', value: -50 });
    modifierAt({ id: 'm', target: 'budget', kind: 'add', value: 0.5 });
    modifierAt({ id: 'm', target: 'nowhere', kind: 'add', value: 1 });
    modifierAt({ id: 'm', target: 'rate', kind: 'set', value: 1 });
  });

  it('name.zh 缺失拒', () => {
    expectErrors([{ id: 'j', name: {}, effects: JADE.effects }], 'name.zh');
  });
});

describe('equipArtifacts：装备位换算成结算入参', () => {
  const TABLE = artifacts([JADE, ABACUS]);

  it('一个都不装：完全中性', () => {
    expect(equipArtifacts(TABLE, [])).toEqual({ jadeCache: null, budgetBonus: 0, modifiers: [], cacheSlots: 0, errors: [] });
  });

  it('只装玉简：给出缓存规格、预算不动', () => {
    const equipped = equipArtifacts(TABLE, ['jade']);
    expect(equipped.jadeCache).toEqual({ sameActionId: true, hitGainMultiplier: 0.7, hitStepCost: 0 });
    expect(equipped.budgetBonus).toBe(0);
    expect(equipped.errors).toEqual([]);
  });

  it('只装算盘：预算 +50、缓存不生效', () => {
    const equipped = equipArtifacts(TABLE, ['abacus']);
    expect(equipped.jadeCache).toBeNull();
    expect(equipped.budgetBonus).toBe(50);
  });

  it('两件都装：两个效果同时在线，顺序不影响结果', () => {
    const forward = equipArtifacts(TABLE, ['jade', 'abacus']);
    const backward = equipArtifacts(TABLE, ['abacus', 'jade']);
    expect(forward.jadeCache).toEqual(backward.jadeCache);
    expect(backward.budgetBonus).toBe(50);
  });

  it('两件各带 +50 预算时相加，同 id 的 modifier 只算最后一个（重复装备不叠加）', () => {
    const doubled = artifacts([
      ABACUS,
      { id: 'abacus2', name: { zh: '算盘贰' }, effects: [{ type: 'modifier', modifier: { id: 'abacus_budget', target: 'budget', kind: 'add', value: 80 } }] },
    ]);
    expect(equipArtifacts(doubled, ['abacus', 'abacus2']).budgetBonus).toBe(80);
    const twoIds = artifacts([
      ABACUS,
      { id: 'abacus2', name: { zh: '算盘贰' }, effects: [{ type: 'modifier', modifier: { id: 'abacus_budget2', target: 'budget', kind: 'add', value: 80 } }] },
    ]);
    expect(equipArtifacts(twoIds, ['abacus', 'abacus2']).budgetBonus).toBe(130);
  });

  it('档面写了表里没有的 id：明说原因，其余照装（与 loadBook 同口径）', () => {
    const equipped = equipArtifacts(TABLE, ['jade', 'art_nope']);
    expect(equipped.budgetBonus).toBe(0);
    expect(equipped.jadeCache).not.toBeNull();
    expect(equipped.errors.join(' ')).toContain('art_nope');
  });

  it('多件缓存同时装备取最后一件：契约没定义叠加，表里也只有一件', () => {
    const two = artifacts([
      JADE,
      { id: 'jade2', name: { zh: '玉简贰' }, effects: [{ type: 'cache', cache: { sameActionId: true, hitGainMultiplier: 0.5, hitStepCost: 1 } }] },
    ]);
    expect(equipArtifacts(two, ['jade', 'jade2']).jadeCache?.hitGainMultiplier).toBe(0.5);
  });
});
