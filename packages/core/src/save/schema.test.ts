import { describe, expect, it } from 'vitest';
import { BASE_BUDGET } from '../types';
import {
  SAVE_SCHEMA_VERSION,
  newGameState,
  parseEnvelope,
  serializeSave,
  validateGameState,
  validateSave,
  type SaveIssue,
} from './schema';

const WORKSPACE = { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h' }] } };

function goodState() {
  return newGameState({ seed: 42, workspace: WORKSPACE, now: 1000 });
}

function goodSave() {
  return { schemaVersion: SAVE_SCHEMA_VERSION, savedAt: 1000, state: goodState() };
}

/** 取一份真档的 JSON 文本，改坏 state 里某个字段后交给校验。 */
function brokenState(mutate: (state: Record<string, unknown>) => void): unknown {
  const parsed = JSON.parse(serializeSave(goodSave())) as { state: Record<string, unknown> };
  mutate(parsed.state);
  return parsed.state;
}

function pathsOf(errors: readonly SaveIssue[]): string[] {
  return errors.map((issue) => issue.path);
}

describe('SaveFile / GameState 校验（契约 §5.1 + §5.2 第 3 步）', () => {
  it('序列化往返无损：qi 用 String 而不是 Qi.format', () => {
    const state = {
      ...goodState(),
      qi: '1234.567891',
      demon: 0.25,
      ownedBooks: ['book_qi_jian'],
      equippedBook: 'book_qi_jian',
      stats: { totalQi: '98765.4321', breakthroughs: 2, playMs: 60000 },
    };
    const save = { schemaVersion: SAVE_SCHEMA_VERSION as 1, savedAt: 2000, state };

    const text = serializeSave(save);
    const result = validateSave(JSON.parse(text));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.save).toEqual(save);
    // Qi.format 会把非整数变成 "1.235e+3"，存档必须原样回来
    expect(result.save?.state.qi).toBe('1234.567891');
    expect(result.save?.state.stats.totalQi).toBe('98765.4321');
  });

  it('非法矩阵：每个字段各自报错并带出路径', () => {
    const cases: readonly [string, (state: Record<string, unknown>) => void][] = [
      ['state.realm', (s) => { s['realm'] = 9; }],
      ['state.realm', (s) => { s['realm'] = -1; }],
      ['state.demon', (s) => { s['demon'] = 1.5; }],
      ['state.equippedBook', (s) => { s['equippedBook'] = 'book_x'; }],
      ['state.equippedArtifacts', (s) => { s['ownedArtifacts'] = []; s['equippedArtifacts'] = ['art_x']; }],
      ['state.qi', (s) => { s['qi'] = 'abc'; }],
      ['state.speed', (s) => { s['speed'] = 2.5; }],
      ['state.programs', (s) => { s['programs'] = 'nope'; }],
      ['state.offlineRate', (s) => { s['offlineRate'] = '0.6'; }],
      ['state.stats.playMs', (s) => { (s['stats'] as Record<string, unknown>)['playMs'] = -1; }],
      ['state.seed', (s) => { s['seed'] = 1.5; }],
    ];

    for (const [path, mutate] of cases) {
      const result = validateGameState(brokenState(mutate));
      expect(result.ok, path).toBe(false);
      expect(pathsOf(result.errors), path).toContain(path);
      expect(result.state).toBeNull();
    }
  });

  it('workspace 不在校验里猜：缺字段或换成字符串都算合法状态，交给 compile 阶段', () => {
    const missing = validateGameState(brokenState((s) => { delete s['workspace']; }));
    const text = validateGameState(brokenState((s) => { s['workspace'] = 'oops'; }));

    expect(missing.ok).toBe(true);
    expect(text.ok).toBe(true);
    expect(missing.state?.workspace).toBeUndefined();
  });

  it('envelope 只解析 schemaVersion：语法坏 / 不是对象 / 版本非数字都归 envelope 阶段', () => {
    expect(parseEnvelope('{"a":').ok).toBe(false);
    expect(parseEnvelope('{"a":').errors.join(' ')).toContain('不是合法 JSON');
    expect(parseEnvelope('[]').errors.join(' ')).toContain('顶层需要对象');
    expect(parseEnvelope('42').errors.join(' ')).toContain('顶层需要对象');
    expect(parseEnvelope('{"foo":1}').errors.join(' ')).toContain('schemaVersion');

    const noState = parseEnvelope('{"schemaVersion":1}');
    expect(noState.ok).toBe(true);
    expect(noState.schemaVersion).toBe(1);
    // 过了 envelope，缺 savedAt / state 由 validate 报出来
    const validated = validateSave(JSON.parse('{"schemaVersion":1}'));
    expect(validated.ok).toBe(false);
    expect(pathsOf(validated.errors)).toEqual(expect.arrayContaining(['savedAt', 'state']));
  });

  it('newGameState 默认值：seed 由入参给，其余按契约 §5.1 的 P0 口径', () => {
    const state = newGameState({ seed: 4294967295, workspace: WORKSPACE, now: 1234 });

    expect(state).toEqual({
      schemaVersion: 1,
      seed: 4294967295,
      realm: 0,
      qi: '0',
      demon: 0,
      workspace: WORKSPACE,
      programs: [],
      budgetPool: BASE_BUDGET,
      computeLimit: null,
      ownedBooks: [],
      equippedBook: null,
      ownedArtifacts: [],
      equippedArtifacts: [],
      offlineRate: 0.6,
      stats: { totalQi: '0', breakthroughs: 0, playMs: 0 },
      lastSeenAt: 1234,
      speed: 1,
      chargeReadyAt: 0,
    });
    expect(validateGameState(state).ok).toBe(true);
  });

  it('开局赠书（D3）：ownedBooks 可注入，equippedBook 仍为 null —— 拥有 ≠ 装备（契约 §5.1）', () => {
    const granted = newGameState({ seed: 7, workspace: WORKSPACE, now: 0, ownedBooks: ['book_zhoutian'] });

    expect(granted.ownedBooks).toEqual(['book_zhoutian']);
    expect(granted.equippedBook).toBeNull();
    expect(validateGameState(granted).ok).toBe(true);
    // 赠书不能放宽「装备 ⊆ 拥有」这条不变量
    const tampered = { ...granted, ownedBooks: [], equippedBook: 'book_zhoutian' };
    expect(pathsOf(validateGameState(tampered).errors)).toContain('state.equippedBook');
    // 不传 / 传空数组都保持 5A 的默认口径
    expect(newGameState({ seed: 7, workspace: WORKSPACE, now: 0 }).ownedBooks).toEqual([]);
    expect(newGameState({ seed: 7, workspace: WORKSPACE, now: 0, ownedBooks: [] }).ownedBooks).toEqual([]);
  });
});
