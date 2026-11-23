import { describe, expect, it } from 'vitest';
import { makeActionSink, Vm, verifyProgram } from '@gongfa/core';
import { compileWorkspace } from './compiler';
import { BATCH_START_COST } from './definitions';
import type { WorkspaceJson } from './compiler';

const CONTENT = {
  realms: [{ id: 'r0', name: { zh: '炼气' }, threshold: 1e3, actionMult: 1, passivePerSec: 0 }],
  actions: [
    { id: 'breath', kind: 'gain', baseGain: 1, demonDelta: 0 },
    { id: 'calm', kind: 'calm', baseGain: 0, demonDelta: -0.0005 },
  ],
} as never;

// 沙漏（批次 13 / P1）：批窗口重置「同 tick 边际递减计数」，代价是每批固定步数。
// 这里用真编译器 + 真 VM + 真 sink 验证语义，不手搓 IR。

function batchWorkspace(batches: number, perBatch: number): WorkspaceJson {
  const batchBlock = (id: string, next?: Record<string, unknown>): Record<string, unknown> => {
    let inner: Record<string, unknown> | undefined;
    for (let i = perBatch; i >= 1; i -= 1) {
      inner = { type: 'breath', id: `${id}-b${i}`, ...(inner ? { next: { block: inner } } : {}) };
    }
    return {
      type: 'gongfa_batch',
      id,
      inputs: { DO: { block: inner } },
      ...(next ? { next: { block: next } } : {}),
    };
  };

  let chain: Record<string, unknown> | undefined;
  for (let i = batches; i >= 1; i -= 1) chain = batchBlock(`batch${i}`, chain);
  return {
    blocks: {
      languageVersion: 0,
      blocks: [{ type: 'tick_hat', id: 'h', x: 32, y: 32, inputs: { BODY: { block: chain } } }],
    },
  } as unknown as WorkspaceJson;
}

function straightWorkspace(n: number): WorkspaceJson {
  let chain: Record<string, unknown> | undefined;
  for (let i = n; i >= 1; i -= 1) chain = { type: 'breath', id: `s${i}`, ...(chain ? { next: { block: chain } } : {}) };
  return {
    blocks: {
      languageVersion: 0,
      blocks: [{ type: 'tick_hat', id: 'h', x: 32, y: 32, inputs: { BODY: { block: chain } } }],
    },
  } as unknown as WorkspaceJson;
}

function runOneTick(json: WorkspaceJson): { gain: number; steps: number } {
  const compiled = compileWorkspace(json);
  expect(compiled.ok, compiled.errors.join('；')).toBe(true);
  const program = compiled.program!;
  let gain = 0;
  const sink = makeActionSink({ content: CONTENT, realmIndex: 0, demonBase: 0.00005 });
  const vm = new Vm({
    content: CONTENT,
    sink: { execute: (request: never) => { const outcome = sink.execute(request); gain += outcome.qi; return outcome; } },
    vars: () => ({ qi: 0, rate: 0, demon: 0, realm: 0, budget: 200 }),
  });
  const loaded = vm.loadPrograms([program]);
  expect(loaded.ok, loaded.errors?.join?.('；')).toBe(true);
  const result = vm.tick();
  return { gain: gain + result.gain, steps: result.steps };
}

describe('沙漏：批窗口', () => {
  it('编译出 BATCH_BEGIN + 批内动作', () => {
    const compiled = compileWorkspace(batchWorkspace(1, 3));
    expect(compiled.ok).toBe(true);
    const code = compiled.program!.code;
    expect(code[0]).toEqual({ op: 'BATCH_BEGIN', steps: BATCH_START_COST });
    expect(code.filter((op) => op.op === 'ACTION')).toHaveLength(3);
  });

  it('两批各 3 次，产出高于直列 6 次（边际递减被重置），每批多花 3+1 步', () => {
    const batched = runOneTick(batchWorkspace(2, 3));
    const straight = runOneTick(straightWorkspace(6));
    // 直列：1 + .8 + .667 + .571 + .5 + .444 ≈ 3.98；两批各 3：2 × 2.467 ≈ 4.93
    expect(batched.gain).toBeGreaterThan(straight.gain * 1.2);
    // BATCH_BEGIN 自己也是一条指令（+1 步），所以每批总成本 = BATCH_START_COST + 1
    expect(batched.steps - straight.steps).toBe(2 * (BATCH_START_COST + 1));
  });

  it('空批编译报错，不静默通过', () => {
    const empty = {
      blocks: {
        languageVersion: 0,
        blocks: [{ type: 'tick_hat', id: 'h', x: 32, y: 32, inputs: { BODY: { block: { type: 'gongfa_batch', id: 'b' } } } }],
      },
    } as unknown as WorkspaceJson;
    expect(compileWorkspace(empty).ok).toBe(false);
  });

  it('verifier 拒绝负数启动步数', () => {
    const bad = verifyProgram({ id: 'x', code: [{ op: 'BATCH_BEGIN', steps: -1 }, { op: 'HALT' }] }, CONTENT);
    expect(bad.ok).toBe(false);
  });
});

describe('引灵 + 阵图', () => {
  it('阵图 3 眼编译成 ACTION{runes:3}', () => {
    const json = {
      blocks: {
        languageVersion: 0,
        blocks: [{
          type: 'tick_hat', id: 'h', x: 32, y: 32,
          inputs: {
            BODY: {
              block: {
                type: 'gongfa_array', id: 'a',
                inputs: { RUNE: { block: { type: 'gongfa_array_rune', id: 'r', fields: { RUNES: 3 } } } },
              },
            },
          },
        }],
      },
    } as unknown as WorkspaceJson;
    const compiled = compileWorkspace(json);
    expect(compiled.ok, compiled.errors.join('；')).toBe(true);
    const action = compiled.program!.code.find((op) => op.op === 'ACTION');
    expect(action).toEqual({ op: 'ACTION', actionId: 'breath', runes: 3 });
  });

  it('不接阵图 = 普通 ACTION（不带 runes）', () => {
    const json = {
      blocks: {
        languageVersion: 0,
        blocks: [{ type: 'tick_hat', id: 'h', x: 32, y: 32, inputs: { BODY: { block: { type: 'gongfa_array', id: 'a' } } } }],
      },
    } as unknown as WorkspaceJson;
    const compiled = compileWorkspace(json);
    expect(compiled.program!.code[0]).toEqual({ op: 'ACTION', actionId: 'breath' });
  });
});
