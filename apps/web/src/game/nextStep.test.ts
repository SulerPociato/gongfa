import { describe, expect, it } from 'vitest';
import { nextStepOf } from './nextStep';
import type { RuntimeState } from './runtime';

// 只造用得到的字段：这行的职责是"选一句话"，不依赖其它字段。
function state(patch: Partial<RuntimeState>): RuntimeState {
  return {
    qi: 0,
    rate: 10,
    demon: 0,
    threshold: 1000,
    canBreakthrough: false,
    canChallenge: false,
    chargeRemainingMs: 0,
    cooldownRemainingMs: 0,
    pauseRemainingMs: 0,
    stall: null,
    nextRealmName: '筑基',
    ...patch,
  } as RuntimeState;
}

describe('nextStepOf', () => {
  it('没有程序时先教第一步', () => {
    expect(nextStepOf({ state: state({}), hasProgram: false })).toContain('拖「吐纳」');
  });

  it('走火惩罚优先于心魔与攒灵力', () => {
    const text = nextStepOf({ state: state({ pauseRemainingMs: 3200, demon: 0.9 }), hasProgram: true });
    expect(text).toContain('走火入魔');
  });

  it('心魔过 0.7 时提示压心魔', () => {
    expect(nextStepOf({ state: state({ demon: 0.72 }), hasProgram: true })).toContain('心魔偏高');
    expect(nextStepOf({ state: state({ demon: 0.69 }), hasProgram: true })).not.toContain('心魔偏高');
  });

  it('撞预算时提示算盘', () => {
    const stall = { programId: 'gongfa', pc: 3, steps: 200, tick: 1, reason: 'budget' } as RuntimeState['stall'];
    expect(nextStepOf({ state: state({ stall }), hasProgram: true })).toContain('算盘');
  });

  it('可渡劫时直接让他点', () => {
    expect(nextStepOf({ state: state({ canChallenge: true }), hasProgram: true })).toContain('点「可渡劫」');
  });

  it('蓄势中给出剩余时间与试炼建议', () => {
    const text = nextStepOf({
      state: state({ canBreakthrough: true, chargeRemainingMs: 120_000 }),
      hasProgram: true,
    });
    expect(text).toContain('2:00');
    expect(text).toContain('试炼');
  });

  it('冷却中给出剩余时间', () => {
    expect(nextStepOf({ state: state({ cooldownRemainingMs: 58_000 }), hasProgram: true })).toContain('0:58');
  });

  it('末境没有下一境时不再说攒灵力', () => {
    expect(nextStepOf({ state: state({ nextRealmName: null }), hasProgram: true })).toContain('末境');
  });

  it('有程序但速率为 0 时提示检查动作', () => {
    expect(nextStepOf({ state: state({ rate: 0 }), hasProgram: true })).toContain('无产出');
  });

  it('正常攒灵力时按剩余量算 ETA', () => {
    const text = nextStepOf({ state: state({ qi: 400, rate: 10 }), hasProgram: true });
    expect(text).toContain('1:00');
  });
});
