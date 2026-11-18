import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/loader';
import type { Content } from '../content/schema';
import { TICK_MS } from '../types';
import { Vm, type TickResult } from './interpreter';
import { MAX_CATCHUP_TICKS, Scheduler } from './scheduler';
import type { Op } from './program';

const CONTENT: Content = loadContent({
  actions: [{ id: 'breath', baseGain: 1, demonDelta: 0, kind: 'gain' }],
  realms: [{ id: 0, name: { zh: '炼气' }, threshold: '1e3', passivePerSec: 0, actionMult: 1 }],
});

const CODE: readonly Op[] = [
  { op: 'ACTION', actionId: 'breath' },
  { op: 'HALT' },
];

function harness(): { vm: Vm; scheduler: Scheduler; ticks: TickResult[]; offline: number[] } {
  const vm = new Vm({ content: CONTENT, sink: { execute: () => ({ qi: 1, demonDelta: 0 }) } });
  const loaded = vm.loadPrograms([{ id: 'p0', code: CODE }]);
  if (!loaded.ok) throw new Error(`装载失败：${JSON.stringify(loaded.errors)}`);

  const ticks: TickResult[] = [];
  const offline: number[] = [];
  const scheduler = new Scheduler({
    vm,
    onTick: (result) => ticks.push(result),
    onOverflowToOffline: (pendingMs) => offline.push(pendingMs),
  });
  return { vm, scheduler, ticks, offline };
}

describe('Scheduler 补帧（契约 §4.5）', () => {
  it('250ms 跑 2 个 tick，余 50ms 留在 accumulator', () => {
    const { vm, scheduler, ticks } = harness();
    const ran = scheduler.advance(250);

    expect(ran.length).toBe(2);
    expect(ticks.length).toBe(2);
    expect(vm.currentTick).toBe(2);
    expect(scheduler.pendingMs).toBe(250 - 2 * TICK_MS);
    expect(ran.map((result) => result.gain)).toEqual([1, 1]);
  });

  it('不足一个 tick 不执行，跨帧累积后补上', () => {
    const { scheduler, vm } = harness();
    expect(scheduler.advance(60).length).toBe(0);
    expect(vm.currentTick).toBe(0);
    expect(scheduler.pendingMs).toBe(60);

    expect(scheduler.advance(60).length).toBe(1);
    expect(scheduler.pendingMs).toBe(20);
  });

  it('单帧最多 5 个 tick，剩余转离线回调', () => {
    const { vm, scheduler, offline } = harness();
    const ran = scheduler.advance(50 * TICK_MS);

    expect(MAX_CATCHUP_TICKS).toBe(5);
    expect(ran.length).toBe(MAX_CATCHUP_TICKS);
    expect(vm.currentTick).toBe(MAX_CATCHUP_TICKS);
    expect(offline).toEqual([45 * TICK_MS]);
    expect(scheduler.pendingMs).toBe(0);
  });

  it('刚好用完 5 个 tick 时不触发离线回调', () => {
    const { scheduler, offline } = harness();
    expect(scheduler.advance(5 * TICK_MS).length).toBe(5);
    expect(offline).toEqual([]);
    expect(scheduler.pendingMs).toBe(0);
  });

  it('dt=0 什么都不做', () => {
    const { scheduler, vm } = harness();
    expect(scheduler.advance(0)).toEqual([]);
    expect(vm.currentTick).toBe(0);
  });

  it('负数、NaN、Infinity 一律 RangeError', () => {
    const { scheduler } = harness();
    expect(() => scheduler.advance(-1)).toThrow(RangeError);
    expect(() => scheduler.advance(Number.NaN)).toThrow(RangeError);
    expect(() => scheduler.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(scheduler.pendingMs).toBe(0);
  });

  it('reset 清空未消费的毫秒', () => {
    const { scheduler, vm } = harness();
    scheduler.advance(60);
    scheduler.reset();
    expect(scheduler.pendingMs).toBe(0);
    expect(scheduler.advance(60).length).toBe(0);
    expect(vm.currentTick).toBe(0);
  });
});
