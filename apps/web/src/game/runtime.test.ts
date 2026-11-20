import { beforeAll, describe, expect, it } from 'vitest';
import type { Program } from '@gongfa/core';
import { createRuntime } from './runtime';

// runtime 读 ?seed= / ?demo= / ?realm= 这些查询串，node 环境里没有 window，构造时先补一个空 location。
beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = { location: { search: '' } };
});

const PROGRAM: Program = {
  id: 'gongfa',
  code: [{ op: 'ACTION', actionId: 'breath' }, { op: 'HALT' }],
};

function running(): ReturnType<typeof createRuntime> {
  const runtime = createRuntime();
  expect(runtime.load(PROGRAM)).toEqual([]);
  return runtime;
}

describe('runtime.run 的 dt 入口（真机停摆的回归）', () => {
  // 先证明「时间在走」，否则下面那句「qi 不变」是空话：rate=0 的 runtime 喂什么 dt 都不会变数。
  it('正控制：1000ms 补满 10 个 tick，qi / rate / ticks 全部在动', () => {
    const runtime = running();
    runtime.run(1000);
    const s = runtime.state();
    expect(s.rate).toBeGreaterThan(0);
    expect(s.ticks).toBe(10);
    expect(s.qi).toBeGreaterThan(0);
  });

  it('run(-1) 不抛，qi / ticks / playMs 一律不动', () => {
    const runtime = running();
    runtime.run(1000);
    const before = runtime.state();
    expect(() => runtime.run(-1)).not.toThrow();
    const after = runtime.state();
    expect(after.qi).toBe(before.qi);
    expect(after.ticks).toBe(before.ticks);
    expect(after.playMs).toBe(before.playMs);
  });

  it('真机那一下 -9.999999523162842 也不抛', () => {
    const runtime = running();
    expect(() => runtime.run(-9.999999523162842)).not.toThrow();
    expect(runtime.state().ticks).toBe(0);
  });

  it('NaN 与 ±Infinity 当 0：非有限的时钟读数不是空窗，不推进也不抛', () => {
    const runtime = running();
    runtime.run(1000);
    const before = runtime.state();
    for (const dt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => runtime.run(dt)).not.toThrow();
    }
    const after = runtime.state();
    expect(after.ticks).toBe(before.ticks);
    expect(after.qi).toBe(before.qi);
  });

  it('run(0) 是合法空帧：不抛、不推进，accumulator 留着跨帧', () => {
    const runtime = running();
    expect(() => runtime.run(0)).not.toThrow();
    expect(runtime.state().ticks).toBe(0);
    runtime.run(60);
    expect(runtime.state().ticks).toBe(0);
    runtime.run(60);
    expect(runtime.state().ticks).toBe(1);
  });
});
