import { describe, expect, it } from 'vitest';
import type { Clock } from '../types';
import type { Program } from '../vm/program';
import { newGameState } from './schema';
import { ACTIVE_KEY, SLOT_KEYS, type SaveStorage } from './storage';
import { EMPTY_PROGRAM, loadGame, type CompileResult } from './load';

function createFake(initial: Record<string, string> = {}): SaveStorage & { set(key: string, text: string): void } {
  const map = new Map(Object.entries(initial));
  return {
    set: (key, text) => { map.set(key, text); },
    read: (key) => map.get(key) ?? null,
    write: (key, value) => { map.set(key, value); return true; },
    remove: (key) => { map.delete(key); },
    keys: () => [...map.keys()],
  };
}

const clock: Clock = { now: () => 9000 };
const WORKSPACE = { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h' }] } };

function saveText(overrides: { qi?: string; realm?: number; schemaVersion?: number; programs?: unknown } = {}): string {
  const state = { ...newGameState({ seed: 1, workspace: WORKSPACE, now: 9000 }) };
  const raw = {
    schemaVersion: overrides.schemaVersion ?? 1,
    savedAt: 9000,
    state: {
      ...state,
      schemaVersion: overrides.schemaVersion ?? 1,
      qi: overrides.qi ?? '1234.5',
      realm: overrides.realm ?? 0,
      programs: overrides.programs ?? [],
    },
  };
  return JSON.stringify(raw);
}

function okCompile(program: Program): (workspace: unknown) => CompileResult {
  return () => ({ ok: true, program, errors: [] });
}

describe('加载顺序与阶段归因（契约 §5.2 固定顺序）', () => {
  it('无存档：fresh=true，不带错误，宿主开新档', () => {
    const storage = createFake();
    const calls: unknown[] = [];

    const result = loadGame({ storage, clock, compile: (workspace) => { calls.push(workspace); return { ok: true, program: EMPTY_PROGRAM, errors: [] }; } });

    expect(result.fresh).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.stage).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.state).toBeNull();
    expect(result.program).toBeNull();
    expect(calls).toEqual([]);
  });

  it('compile 失败 → 降级：空程序 + stage=compile + 数值状态照旧，页面能起来', () => {
    const storage = createFake({ [SLOT_KEYS[0]!]: saveText({ qi: '777.25' }) });
    const broken = (workspace: unknown): CompileResult => ({ ok: false, program: null, errors: [`「每 tick」入口块缺失（收到 workspace=${JSON.stringify(workspace) === undefined ? 'undefined' : 'object'}）`] });

    const result = loadGame({ storage, clock, compile: broken });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('compile');
    expect(result.program).toEqual(EMPTY_PROGRAM);
    expect(result.program?.code).toEqual([{ op: 'HALT' }]);
    // 降级不等于丢进度：qi / demon 这些数值仍然交回宿主
    expect(result.state?.qi).toBe('777.25');
    expect(result.errors.join(' ')).toContain('入口块缺失');
    expect(result.fresh).toBe(false);
  });

  it('programs 只是缓存：编译吃 workspace，存档里的 IR 一个字都不读', () => {
    const stale: Program = { id: 'stale-from-old-save', code: [{ op: 'PUSH', value: 999 }, { op: 'HALT' }] };
    const rebuilt: Program = { id: 'gongfa', code: [{ op: 'ACTION', actionId: 'breath' }, { op: 'HALT' }] };
    const storage = createFake({ [SLOT_KEYS[0]!]: saveText({ programs: [stale] }) });
    const seen: unknown[] = [];

    const result = loadGame({
      storage,
      clock,
      compile: (workspace) => { seen.push(workspace); return { ok: true, program: rebuilt, errors: [] }; },
    });

    expect(result.errors, 'programs 不该影响读取').toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.program).toEqual(rebuilt);
    expect(JSON.stringify(result.program)).not.toContain('stale-from-old-save');
    expect(seen).toEqual([WORKSPACE]);
  });

  it('三种坏档各自报出失败阶段：envelope / migrate / validate', () => {
    const cases: readonly [string, string, string][] = [
      ['envelope', 'garbage{', '不是合法 JSON'],
      ['migrate', saveText({ schemaVersion: 2 }), '比本程序支持的版本新'],
      ['validate', saveText({ realm: 4 }), 'state.realm'],
    ];

    for (const [stage, text, fragment] of cases) {
      const storage = createFake({ [SLOT_KEYS[0]!]: text });
      const result = loadGame({ storage, clock, compile: okCompile(EMPTY_PROGRAM) });

      expect(result.stage, stage).toBe(stage);
      expect(result.ok, stage).toBe(false);
      expect(result.errors.join(' '), stage).toContain(fragment);
      // 坏档留了备份，槽位清空，下一次就是干净的新档
      expect(result.corruptedKey, stage).toBe('gongfa:corrupted-9000');
      expect(storage.read(SLOT_KEYS[0]!), stage).toBeNull();
      expect(storage.read(ACTIVE_KEY), stage).toBeNull();
    }
  });

  it('install 失败 → stage=install，编译结果仍然交回', () => {
    const storage = createFake({ [SLOT_KEYS[0]!]: saveText() });
    const program: Program = { id: 'gongfa', code: [{ op: 'ACTION', actionId: 'nope' }, { op: 'HALT' }] };

    const result = loadGame({
      storage,
      clock,
      compile: okCompile(program),
      install: () => ['装载被 verifier 拒绝：action-id nope'],
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('install');
    expect(result.program).toEqual(program);
    expect(result.state?.qi).toBe('1234.5');
    expect(result.errors.join(' ')).toContain('action-id nope');
  });
});
