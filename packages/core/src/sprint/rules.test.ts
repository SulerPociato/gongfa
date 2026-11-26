import { describe, expect, it } from 'vitest';
import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import { loadContent } from '../content/loader';
import { CHARGE_WINDOW_MS, armCharge, chargeRemainingMs } from '../realm/rules';
import {
  SPRINT_GOAL_QI,
  SPRINT_WINDOW_MS,
  SPRINT_WINDOW_TICKS,
  SprintWindow,
  halveChargeWindowMs,
  shiftChargeReadyAt,
  sprintGoalQi,
} from './rules';

// 真表：试炼和蓄势窗口的对账要在 shipped JSON 上做，夹具只能证明函数自洽。
const REALMS = loadContent({ actions: actionsJson, realms: realmsJson }).realms;

describe('试炼常量逐字对契约（§7.1.1）', () => {
  it('60 秒窗口、九境目标 480 / 3 200 / 30 000 / 157 000 / 2e6 / 1.2e7 / 8e7 / 5e8 / 3e9', () => {
    expect(SPRINT_WINDOW_MS).toBe(60_000);
    expect(SPRINT_GOAL_QI).toEqual([480, 3_200, 30_000, 157_000, 2_000_000, 12_000_000, 80_000_000, 500_000_000, 3_000_000_000]);
  });

  it('窗口格数 = 60 秒 / TICK_MS = 600 格', () => {
    expect(SPRINT_WINDOW_TICKS).toBe(600);
  });

  it('目标按【当前境界】取，窗口按【目标境界】取：两件事不能都写成 realmIndex+1', () => {
    expect(sprintGoalQi(1)).toBe(3_200);
    expect(CHARGE_WINDOW_MS[1 + 1]).toBe(2 * 60_000);
  });

  it('表里没有的行是 undefined，不是 0：0 会让第一 tick 就「达成」', () => {
    expect(sprintGoalQi(REALMS.length)).toBeUndefined();
    expect(sprintGoalQi(-1)).toBeUndefined();
    expect(sprintGoalQi(0)).toBe(480);
  });
});

describe('SprintWindow：滑动 60 秒窗口只算最近 600 个 tick', () => {
  const fill = (window: SprintWindow, value: number, times: number): void => {
    for (let i = 0; i < times; i++) window.push(value);
  };

  it('空窗口是 0', () => {
    expect(new SprintWindow(3).total()).toBe(0);
  });

  it('未满窗口时窗口和就是全部产出', () => {
    const window = new SprintWindow(3);
    fill(window, 2, 2);
    expect(window.total()).toBe(4);
  });

  it('满窗之后逐格挤出最旧的那一格，窗口和不再增长（用「本境界总产出」就是这里会算错）', () => {
    const window = new SprintWindow(3);
    fill(window, 2, 10);
    expect(window.total()).toBe(6);
  });

  it('挤掉旧格后新产出才进得来：覆盖顺序是环形的', () => {
    const window = new SprintWindow(3);
    fill(window, 2, 3);
    window.push(10);
    expect(window.total()).toBe(14);
    window.push(0);
    expect(window.total()).toBe(12);
  });

  it('等值比较：刚好到目标算达成', () => {
    const window = new SprintWindow(2);
    fill(window, 4, 2);
    expect(window.isAtOrAbove(8)).toBe(true);
    expect(window.isAtOrAbove(8.001)).toBe(false);
  });

  it('reset（渡劫成功换境）之后窗口从零重来', () => {
    const window = new SprintWindow(3);
    fill(window, 5, 3);
    window.reset();
    expect(window.total()).toBe(0);
    fill(window, 1, 2);
    expect(window.total()).toBe(2);
  });

  it('600 格按炼气单吐纳（1/tick）刚好差 80 才够 480：试炼要玩家动手，不是白送', () => {
    const window = new SprintWindow();
    fill(window, 1, 600);
    expect(window.total()).toBe(600);
    fill(window, 0, 120);
    expect(window.total()).toBe(480);
    expect(window.isAtOrAbove(sprintGoalQi(0)!)).toBe(true);
  });
});

describe('蓄势减半：先达标与先试炼两条时序要落在同一个数上（§7.1.1 + §7.3）', () => {
  const NOW = 1_700_000_000_000;
  const base = CHARGE_WINDOW_MS[2]!;

  it('未达成时窗口原样；达成后减半', () => {
    expect(halveChargeWindowMs(base, false)).toBe(base);
    expect(halveChargeWindowMs(base, true)).toBe(base / 2);
  });

  it('窗口 0（炼气、演示模式、?charge=0）减半还是 0', () => {
    expect(halveChargeWindowMs(0, true)).toBe(0);
  });

  it('达标之前达成：armCharge 用减半后的窗口，完成时刻 = 达标 + 半窗', () => {
    const armed = armCharge({ realm: REALMS[1]!, windowMs: halveChargeWindowMs(base, true), qi: 10_000, chargeReadyAt: 0, now: NOW });
    expect(armed).toBe(NOW + 1 * 60_000);
  });

  it('达标之后才达成：把已 arm 的完成时刻前移半个窗口，与上一条同值', () => {
    const armedFull = armCharge({ realm: REALMS[1]!, windowMs: base, qi: 10_000, chargeReadyAt: 0, now: NOW });
    expect(armedFull).toBe(NOW + 2 * 60_000);
    expect(shiftChargeReadyAt(armedFull, base)).toBe(NOW + 1 * 60_000);
  });

  it('未 arm（0）时不挪：0 专留给「从未达标」，挪了就变成「已经就绪」', () => {
    expect(shiftChargeReadyAt(0, base)).toBe(0);
  });

  it('等待已过大半时达成：前移半窗直接落到过去 = 立即可渡', () => {
    const armed = armCharge({ realm: REALMS[1]!, windowMs: base, qi: 10_000, chargeReadyAt: 0, now: NOW - 90_000 });
    expect(chargeRemainingMs(armed, NOW)).toBe(30_000);
    expect(chargeRemainingMs(shiftChargeReadyAt(armed, base), NOW)).toBe(0);
  });

  it('只生效一次：重复前移会叠出免费就绪，所以调用方必须在已达成时跳过（这里锁住幂等前提）', () => {
    const armedFull = armCharge({ realm: REALMS[1]!, windowMs: base, qi: 10_000, chargeReadyAt: 0, now: NOW });
    const once = shiftChargeReadyAt(armedFull, base);
    expect(once).not.toBe(shiftChargeReadyAt(once, base));
  });
});
