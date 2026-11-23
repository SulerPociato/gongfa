import { describe, expect, it } from 'vitest';
import { loadContent } from './loader';
import { ContentValidationError, type Content } from './schema';

const ACTIONS = [
  { id: 'breath', baseGain: 1, demonDelta: 0, kind: 'gain' },
  { id: 'calm', baseGain: 0, demonDelta: -0.0003, kind: 'calm' },
];
const REALMS = [{ id: 0, name: { zh: '炼气' }, threshold: '1e3', passivePerSec: 0, actionMult: 1 }];

function errorText(actions: unknown, realms: unknown): string {
  try {
    loadContent({ actions, realms });
  } catch (error) {
    if (error instanceof ContentValidationError) return error.errors.join('\n');
    throw error;
  }
  throw new Error('预期校验失败，但没有抛错');
}

function load(actions: unknown, realms: unknown): Content {
  return loadContent({ actions, realms });
}

describe('loadContent 正常路径', () => {
  it('返回类型化的动作表与境界表', () => {
    const content = load(ACTIONS, REALMS);
    expect(content.actions[0]?.id).toBe('breath');
    expect(content.actions[0]?.baseGain).toBe(1);
    expect(content.actions[1]?.demonDelta).toBe(-0.0003);
    expect(content.realms[0]?.threshold).toBe(1000);
    expect(content.realms[0]?.name.zh).toBe('炼气');
    expect(content.realms[0]?.actionMult).toBe(1);
  });

  it('threshold 也接受裸数字', () => {
    const numericRealm = [{ id: 0, name: { zh: '炼气' }, threshold: 1e3, passivePerSec: 0, actionMult: 1 }];
    expect(load(ACTIONS, numericRealm).realms[0]?.threshold).toBe(1000);
  });
});

describe('actions.json 校验', () => {
  it('非数组与空数组都拒绝', () => {
    expect(errorText({ id: 'breath' }, REALMS)).toContain('必须是非空数组');
    expect(errorText([], REALMS)).toContain('必须是非空数组');
  });

  it('id 重复', () => {
    const duplicated = [ACTIONS[0], ACTIONS[0]];
    expect(errorText(duplicated, REALMS)).toContain('actions.json[1].id 重复: breath');
  });

  it('id 缺失或为空', () => {
    expect(errorText([{ baseGain: 1, demonDelta: 0, kind: 'gain' }], REALMS)).toContain('actions.json[0].id');
    expect(errorText([{ id: '  ', baseGain: 1, demonDelta: 0, kind: 'gain' }], REALMS)).toContain('需要非空字符串');
  });

  it('kind 必须在白名单内', () => {
    expect(errorText([{ id: 'breath', baseGain: 1, demonDelta: 0, kind: 'breathe' }], REALMS)).toContain(
      'gain | calm | other',
    );
  });

  it('baseGain 必须是非负有限数字', () => {
    expect(errorText([{ id: 'breath', baseGain: -1, demonDelta: 0, kind: 'gain' }], REALMS)).toContain('需要 ≥ 0');
    expect(errorText([{ id: 'breath', baseGain: '1', demonDelta: 0, kind: 'gain' }], REALMS)).toContain(
      '需要有限数字',
    );
  });

  it('demonDelta 缺失即报错，不做默认', () => {
    expect(errorText([{ id: 'breath', baseGain: 1, kind: 'gain' }], REALMS)).toContain('demonDelta');
  });
});

describe('realms.json 校验', () => {
  it('首个境界必须是 id 0', () => {
    expect(errorText(ACTIONS, [{ id: 1, name: { zh: '筑基' }, threshold: '2e4', passivePerSec: 5, actionMult: 3 }])).toContain(
      '首个境界必须是 id 0',
    );
  });

  it('realm id 必须是整数', () => {
    expect(errorText(ACTIONS, [{ id: 0.5, name: { zh: '炼气' }, threshold: '1e3' }])).toContain('需要整数');
  });

  it('threshold 必须能解析且 > 0', () => {
    expect(errorText(ACTIONS, [{ id: 0, name: { zh: '炼气' }, threshold: 'abc' }])).toContain('无法解析为数字');
    expect(errorText(ACTIONS, [{ id: 0, name: { zh: '炼气' }, threshold: '0' }])).toContain('需要 > 0');
  });

  it('多境界的 id / threshold 递增与 actionMult 不回退', () => {
    const errors = errorText(
      ACTIONS,
      [
        { id: 0, name: { zh: '炼气' }, threshold: '2e3', passivePerSec: 0, actionMult: 3 },
        { id: 0, name: { zh: '筑基' }, threshold: '1e3', passivePerSec: 5, actionMult: 1 },
      ],
    );
    expect(errors).toContain('id 重复: 0');
    expect(errors).toContain('threshold: 必须严格递增');
    expect(errors).toContain('actionMult: 不得回退');
  });

  it('name.zh 缺失即报错', () => {
    expect(errorText(ACTIONS, [{ id: 0, name: {}, threshold: '1e3' }])).toContain('name.zh');
  });
});

describe('校验失败可见', () => {
  it('一次抛出的错误多于一条', () => {
    try {
      loadContent({ actions: [{ id: 'breath', baseGain: -1, demonDelta: 0, kind: 'nope' }], realms: REALMS });
    } catch (error) {
      expect(error).toBeInstanceOf(ContentValidationError);
      const errors = (error as ContentValidationError).errors;
      expect(errors.length).toBeGreaterThan(1);
      return;
    }
    throw new Error('预期校验失败，但没有抛错');
  });
});
