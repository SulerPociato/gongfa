import { describe, expect, it } from 'vitest';
import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import { loadContent } from '../content/loader';
import { bookSettleDeps } from '../book/machine';
import { loadBook, loadBooks, type BookDef } from '../content/books';
import { TICKS_PER_SEC } from '../types';
import type { ActionRequest } from '../vm/interpreter';
import { makeActionSink } from '../modifier/settle';
import { drawAt } from '../rng/mulberry32';
import zhoutianJson from '../../../../content/books/book_zhoutian.json';
import {
  AUTO_RATE,
  CHALLENGE_COOLDOWN_MS,
  CHALLENGE_INDEX_BASE,
  CHALLENGE_TRIAL_MS,
  CHARGE_WINDOW_MS,
  FAILURE_QI_MULT,
  GUARANTEE_ATTEMPT,
  MANUAL_RATE,
  armCharge,
  breakthrough,
  chargeRemainingMs,
  isChargeReady,
  isThresholdReached,
  passivePerTick,
  resolveChallenge,
} from './rules';

// 真表，不是夹具：本文件里凡是对得上契约 §2.3 / §3 的数字，都必须在 shipped JSON 上成立。
const CONTENT = loadContent({ actions: actionsJson, realms: realmsJson });
const REALMS = CONTENT.realms;

const BOOKS = loadBooks([zhoutianJson]);
const loaded = loadBook(BOOKS, 'book_zhoutian');
if (!loaded.ok || loaded.book === null) throw new Error('《周天吐纳诀》没装起来，衰减相关的用例无从谈起');
const BOOK: BookDef = loaded.book;

function req(k: number, loopDepth = 0): ActionRequest {
  return { actionId: 'breath', k, pc: 0, loopDepth };
}

describe('content/realms.json 逐字段对契约（§2.3 表 + §3 阈值，不自己算）', () => {
  it('四个境界，id 0..3，名字与阈值/被动/倍率一字不差', () => {
    expect(REALMS.map((realm) => realm.id)).toEqual([0, 1, 2, 3]);
    expect(REALMS.map((realm) => realm.name.zh)).toEqual(['炼气', '筑基', '金丹', '元婴']);
    expect(REALMS.map((realm) => realm.threshold)).toEqual([1e3, 2e4, 4e5, 2.5e6]);
    expect(REALMS.map((realm) => realm.passivePerSec)).toEqual([0, 5, 30, 150]);
    expect(REALMS.map((realm) => realm.actionMult)).toEqual([1, 3, 25, 100]);
  });

  it('表能过 loadContent 的多行规则（首境 id 0、id/threshold 严格递增、actionMult 不回退）', () => {
    expect(REALMS.length).toBe(4);
    expect(() => loadContent({ actions: actionsJson, realms: realmsJson })).not.toThrow();
  });
});

describe('境界被动（契约 §2.3：perTickTotal = perTickGain + realmPassivePerSec / 10）', () => {
  it('每 tick 被动 = passivePerSec / 10', () => {
    expect(passivePerTick(REALMS[0]!)).toBe(0);
    expect(passivePerTick(REALMS[1]!)).toBe(0.5);
    expect(passivePerTick(REALMS[2]!)).toBe(3);
    expect(passivePerTick(REALMS[3]!)).toBe(15);
  });

  it('开局单吐纳在筑基是 35.0/秒：动作 3 + 被动 0.5，再乘 10 tick/秒', () => {
    const gain = makeActionSink({ content: CONTENT, realmIndex: 1 }).execute(req(1)).qi;
    expect(gain).toBe(3); // baseGain 1 × actionMult(1)=1 × realmActionMult 3（无书、无玉简、无修饰）
    expect((gain + passivePerTick(REALMS[1]!)) * TICKS_PER_SEC).toBe(35);
  });

  it('同一程序在炼气仍是 10.0/秒（被动 0，60s=600 的回归不变量不被破坏）', () => {
    const gain = makeActionSink({ content: CONTENT, realmIndex: 0 }).execute(req(1)).qi;
    expect((gain + passivePerTick(REALMS[0]!)) * TICKS_PER_SEC).toBe(10);
  });

  it('筑基还装着书时是 25.0/秒：realmActionMult 3 × bookDecay 2/3 + 被动 0.5', () => {
    const sink = makeActionSink({ content: CONTENT, realmIndex: 1, ...bookSettleDeps(BOOK, 1) });
    expect(sink.execute(req(1)).qi).toBeCloseTo(2, 12);
    expect((sink.execute(req(1)).qi + passivePerTick(REALMS[1]!)) * TICKS_PER_SEC).toBeCloseTo(25, 12);
  });

  it('金丹 / 元婴的同程序速率（只做 sanity，别和契约目标表的 626/3091 混：那张表带循环与玉简）', () => {
    const at = (index: number) => (makeActionSink({ content: CONTENT, realmIndex: index }).execute(req(1)).qi + passivePerTick(REALMS[index]!)) * TICKS_PER_SEC;
    expect(at(2)).toBe(280);
    expect(at(3)).toBe(1150);
  });
});

describe('突破门槛（任务 6 的简化路径仍要成立：阈值等号算达标）', () => {
  it('阈值等号算达标，差一点都不算', () => {
    expect(isThresholdReached(1000, REALMS[0]!)).toBe(true);
    expect(isThresholdReached(999.999, REALMS[0]!)).toBe(false);
    expect(isThresholdReached(20000, REALMS[1]!)).toBe(true);
    expect(isThresholdReached(2_500_000, REALMS[3]!)).toBe(true);
  });
});

describe('breakthrough 结果（契约 §7.1：成功 → 境界 +1、qi=0、demon=0）', () => {
  const at = (qi: number, realmIndex = 0, demon = 0.8) => ({ qi, demon, realm: REALMS[realmIndex]!.id });

  it('达标即进阶：数字归零、境界 +1、下标 +1', () => {
    const out = breakthrough({ realms: REALMS, realmIndex: 0, state: at(1000) });
    expect(out.ok).toBe(true);
    expect(out.realmIndex).toBe(1);
    expect(out.state).toEqual({ qi: 0, demon: 0, realm: 1 });
    expect(out.errors).toEqual([]);
  });

  it('存量超阈值也照样清零（不是减去阈值）', () => {
    const out = breakthrough({ realms: REALMS, realmIndex: 1, state: at(999_999, 1, 1) });
    expect(out.state).toEqual({ qi: 0, demon: 0, realm: 2 });
  });

  it('未达标：不推进、数字一动不动，并且说明差多少', () => {
    const input = { realms: REALMS, realmIndex: 0, state: at(999.5) };
    const out = breakthrough(input);
    expect(out.ok).toBe(false);
    expect(out.realmIndex).toBe(0);
    expect(out.state).toEqual(input.state);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('阈值');
  });

  it('末境（元婴）无可渡之劫：报境界名，不抛异常', () => {
    const out = breakthrough({ realms: REALMS, realmIndex: 3, state: at(1e12, 3) });
    expect(out.ok).toBe(false);
    expect(out.realmIndex).toBe(3);
    expect(out.state).toEqual({ qi: 1e12, demon: 0.8, realm: 3 });
    expect(out.errors[0]).toContain('元婴');
  });

  it('下标越界（含 -1）只报错：坏表/坏档不该把运行时报成异常', () => {
    for (const realmIndex of [-1, 4, 9]) {
      const input = { realms: REALMS, realmIndex, state: { qi: 5000, demon: 0.2, realm: 0 } };
      const out = breakthrough(input);
      expect(out.ok).toBe(false);
      expect(out.realmIndex).toBe(realmIndex);
      expect(out.state).toEqual(input.state);
      expect(out.errors.length).toBeGreaterThan(0);
    }
  });

  it('一路渡到顶：0→1→2→3 成功四次里前三次成立，第四次被末境挡住', () => {
    let realmIndex = 0;
    let state = { qi: 1e3, demon: 0.9, realm: 0 };
    const visited: number[] = [];
    for (let step = 0; step < 4; step++) {
      const out = breakthrough({ realms: REALMS, realmIndex, state: { ...state, qi: REALMS[realmIndex]!.threshold } });
      if (!out.ok) break;
      realmIndex = out.realmIndex;
      visited.push(state.realm + 1);
      state = out.state;
    }
    expect(visited).toEqual([1, 2, 3]);
    expect(realmIndex).toBe(3);
  });
});

// ——————————————————————————————————————————————————————————————
// 任务 6.5：蓄势（契约 §7.3）与渡劫结算（§7.1 / 01-design §4.4）
// NOW 是任意 epoch 毫秒：蓄势算的是差值，绝对时刻不参与结论（wallClock 就是 Date.now()）。
// ——————————————————————————————————————————————————————————————
const NOW = 1_795_000_000_000;

const atRealm = (realmIndex: number, qi: number, demon = 0.5) => ({ qi, demon, realm: REALMS[realmIndex]!.id });

describe('常量逐字对契约（§7.3 窗口 + §7.1 概率/时长/保底/索引）', () => {
  it('窗口按【目标境界】下标取：进筑基 0、进金丹 15 分钟、进元婴 60 分钟；下标 0 是「炼气不是任何挑战的目标」', () => {
    expect(CHARGE_WINDOW_MS).toEqual([0, 0, 15 * 60_000, 60 * 60_000]);
    expect(CHARGE_WINDOW_MS[1]).toBe(0);
    expect(CHARGE_WINDOW_MS[2]).toBe(900_000);
    expect(CHARGE_WINDOW_MS[3]).toBe(3_600_000);
  });

  it('挑战 10 秒、冷却 60 秒、保底第 3 次、85%/60%、失败 ×0.85、索引基址 1e6', () => {
    expect(CHALLENGE_TRIAL_MS).toBe(10_000);
    expect(CHALLENGE_COOLDOWN_MS).toBe(60_000);
    expect(GUARANTEE_ATTEMPT).toBe(3);
    expect(MANUAL_RATE).toBe(0.85);
    expect(AUTO_RATE).toBe(0.6);
    expect(FAILURE_QI_MULT).toBe(0.85);
    expect(CHALLENGE_INDEX_BASE).toBe(1_000_000);
  });
});

describe('armCharge：从存量首次达标那一刻起算（§7.3）', () => {
  const row = (realmIndex: number) => ({ realm: REALMS[realmIndex]!, windowMs: CHARGE_WINDOW_MS[realmIndex + 1]! });

  it('差 0.001 不写：chargeReadyAt 保持 0（0 = 本境界从未达标）', () => {
    expect(armCharge({ ...row(1), qi: 19_999.999, chargeReadyAt: 0, now: NOW })).toBe(0);
  });

  it('首次达标 → now + 窗口（筑基起算 15 分钟）', () => {
    expect(armCharge({ ...row(1), qi: 20_000, chargeReadyAt: 0, now: NOW })).toBe(NOW + 900_000);
  });

  it('炼气窗口 0 时写的是 now，不是 0：now 表示「立刻可渡」，0 专留给从未达标', () => {
    const armed = armCharge({ ...row(0), qi: 1000, chargeReadyAt: 0, now: NOW });
    expect(armed).toBe(NOW);
    expect(armed).not.toBe(0);
    expect(isChargeReady(armed, NOW)).toBe(true);
  });

  it('重复挑战不重置（§7.3）：已 arm 之后哪怕存量掉回阈值下，也原样返回', () => {
    const armed = NOW + 900_000;
    expect(armCharge({ ...row(1), qi: 20_000, chargeReadyAt: armed, now: NOW + 60_000 })).toBe(armed);
    expect(armCharge({ ...row(1), qi: 1_000, chargeReadyAt: armed, now: NOW + 60_000 })).toBe(armed);
  });

  it('幂等：连调 50 次（每 tick 都会调）不会把窗口累加上去', () => {
    let value = 0;
    for (let i = 0; i < 50; i++) value = armCharge({ ...row(2), qi: 4e5, chargeReadyAt: value, now: NOW + i * 1000 });
    expect(value).toBe(NOW + 3_600_000);
  });

  it('窗口由宿主传进来：?demo=1 与 ?charge=0 的「跳过」是策略，核心只做加法', () => {
    expect(armCharge({ realm: REALMS[2]!, windowMs: 0, qi: 4e5, chargeReadyAt: 0, now: NOW })).toBe(NOW);
  });
});

describe('chargeRemainingMs / isChargeReady（按钮灰态与剩余时间的数据源）', () => {
  it('未 arm（0）永远没就绪，剩余 0 —— HUD 用 chargeReadyAt===0 说「先攒存量」', () => {
    expect(isChargeReady(0, NOW + 10_000)).toBe(false);
    expect(chargeRemainingMs(0, NOW + 10_000)).toBe(0);
  });

  it('等号算就绪：恰好到点那一刻就能冲关', () => {
    expect(isChargeReady(NOW + 900_000, NOW + 900_000)).toBe(true);
    expect(chargeRemainingMs(NOW + 900_000, NOW + 900_000)).toBe(0);
  });

  it('差一毫秒没就绪，剩余按毫秒给', () => {
    expect(isChargeReady(NOW + 900_000, NOW + 899_999)).toBe(false);
    expect(chargeRemainingMs(NOW + 900_000, NOW + 899_999)).toBe(1);
  });

  it('过点之后剩余是 0，不返负数', () => {
    expect(chargeRemainingMs(NOW + 900_000, NOW + 1_000_000)).toBe(0);
  });
});

describe('resolveChallenge：手动 85% / 托管 60% / 第 3 次必成（§7.1）', () => {
  const challenge = (realmIndex: number, attempt: number, mode: 'manual' | 'auto', seed = 1) =>
    resolveChallenge({ realms: REALMS, realmIndex, state: atRealm(realmIndex, REALMS[realmIndex]!.threshold), seed, attempt, mode });

  // 先算出来再用，不靠运气：找一个必赢 / 必输的种子
  const winningSeed = (attempt: number, rate: number) => {
    let seed = 1;
    while (drawAt(seed, CHALLENGE_INDEX_BASE + attempt) >= rate) seed += 1;
    return seed;
  };
  const losingSeed = (attempt: number, rate: number) => {
    let seed = 1;
    while (drawAt(seed, CHALLENGE_INDEX_BASE + attempt) < rate) seed += 1;
    return seed;
  };

  it('roll 恒等于 drawAt(seed, 1_000_000 + N)，与 tick 无关', () => {
    for (const seed of [1, 7, 12_345, 4_000_000_000]) {
      for (const attempt of [1, 2, 3]) {
        expect(challenge(0, attempt, 'manual', seed).roll).toBe(drawAt(seed, CHALLENGE_INDEX_BASE + attempt));
      }
    }
  });

  it('挑战索引段不与杂念索引段相撞（两条流各自独立，Python 才分得开）', () => {
    const noiseIndexes = new Set<number>();
    for (let tick = 1; tick <= 1200; tick++) noiseIndexes.add(tick);
    for (let attempt = 1; attempt <= GUARANTEE_ATTEMPT; attempt++) expect(noiseIndexes.has(CHALLENGE_INDEX_BASE + attempt)).toBe(false);
    expect(CHALLENGE_INDEX_BASE).toBeGreaterThan(1200);
  });

  it('手动档：N=1、N=2 时成功 ⟺ roll < 0.85；N=3 必成但仍掷骰（保底不改变索引口径）', () => {
    for (const attempt of [1, 2]) {
      const out = challenge(0, attempt, 'manual', 1);
      expect(out.forced).toBe(false);
      expect(out.rate).toBe(MANUAL_RATE);
      expect(out.ok).toBe(out.roll < MANUAL_RATE);
    }
    const pity = challenge(0, GUARANTEE_ATTEMPT, 'manual', losingSeed(GUARANTEE_ATTEMPT, MANUAL_RATE));
    expect(pity.ok).toBe(true);
    expect(pity.forced).toBe(true);
    expect(pity.roll).toBe(drawAt(losingSeed(GUARANTEE_ATTEMPT, MANUAL_RATE), CHALLENGE_INDEX_BASE + GUARANTEE_ATTEMPT));
  });

  it('托管档 60%：同一 roll 口径；同一个 (seed, N) 托管过了手动就一定过', () => {
    for (const seed of [1, 2, 3, 12_345]) {
      const auto = challenge(0, 1, 'auto', seed);
      const manual = challenge(0, 1, 'manual', seed);
      expect(auto.rate).toBe(AUTO_RATE);
      expect(auto.ok).toBe(auto.roll < AUTO_RATE);
      expect(manual.roll).toBe(auto.roll);
      if (auto.ok) expect(manual.ok).toBe(true);
    }
  });

  it('成功：境界 +1、qi=0、demon=0、悟道不涨', () => {
    const seed = winningSeed(1, MANUAL_RATE);
    const out = resolveChallenge({ realms: REALMS, realmIndex: 1, state: atRealm(1, 25_000), seed, attempt: 1, mode: 'manual' });
    expect(out.ok).toBe(true);
    expect(out.realmIndex).toBe(2);
    expect(out.state).toEqual({ qi: 0, demon: 0, realm: 2 });
    expect(out.insight).toBe(0);
    expect(out.errors).toEqual([]);
  });

  it('失败：存量 ×0.85、心魔归 0、境界不动、悟道 +1', () => {
    const seed = losingSeed(1, MANUAL_RATE);
    const out = resolveChallenge({ realms: REALMS, realmIndex: 1, state: { qi: 20_500, demon: 0.9, realm: 1 }, seed, attempt: 1, mode: 'manual' });
    expect(out.ok).toBe(false);
    expect(out.forced).toBe(false);
    expect(out.realmIndex).toBe(1);
    expect(out.state.qi).toBe(20_500 * FAILURE_QI_MULT);
    expect(out.state.demon).toBe(0);
    expect(out.state.realm).toBe(1);
    expect(out.insight).toBe(1);
    expect(out.errors).toEqual([]);
  });

  it('结算那刻存量已掉到阈值下（例如 10 秒里走了火）：报错、数字一动不动', () => {
    const out = resolveChallenge({ realms: REALMS, realmIndex: 1, state: atRealm(1, 19_999), seed: 1, attempt: 1, mode: 'auto' });
    expect(out.ok).toBe(false);
    expect(out.errors.join(' ')).toContain('阈值');
    expect(out.state).toEqual(atRealm(1, 19_999));
    expect(out.insight).toBe(0);
    expect(out.realmIndex).toBe(1);
  });

  it('末境（元婴）没有劫可渡：报境界名，不动数字', () => {
    const out = resolveChallenge({ realms: REALMS, realmIndex: 3, state: atRealm(3, 1e12), seed: 1, attempt: 1, mode: 'manual' });
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toContain('元婴');
    expect(out.state).toEqual(atRealm(3, 1e12));
    expect(out.insight).toBe(0);
    expect(out.realmIndex).toBe(3);
  });

  it('N 必须从 1 起：0、负数、非整数、NaN 一律报错，不静默当第 1 次', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      const out = resolveChallenge({ realms: REALMS, realmIndex: 0, state: atRealm(0, 1000), seed: 1, attempt, mode: 'manual' });
      expect(out.ok).toBe(false);
      expect(out.errors.length).toBeGreaterThan(0);
      expect(out.state).toEqual(atRealm(0, 1000));
    }
  });

  it('下标越界只报错（坏存档不该把运行时报成异常）', () => {
    for (const realmIndex of [-1, 4, 9]) {
      const out = resolveChallenge({ realms: REALMS, realmIndex, state: { qi: 5000, demon: 0.2, realm: 0 }, seed: 1, attempt: 1, mode: 'manual' });
      expect(out.ok).toBe(false);
      expect(out.realmIndex).toBe(realmIndex);
      expect(out.errors.length).toBeGreaterThan(0);
    }
  });

  it('实测成功率：手动档 2000 个种子（区间 [0.82,0.88]，原始计数打出来）', () => {
    const samples = 2000;
    let wins = 0;
    for (let seed = 1; seed <= samples; seed++) if (challenge(0, 1, 'manual', seed).ok) wins += 1;
    const measured = wins / samples;
    console.log(`手动档实测 ${wins}/${samples} = ${measured.toFixed(4)}（契约 0.85）`);
    expect(measured).toBeGreaterThanOrEqual(0.82);
    expect(measured).toBeLessThanOrEqual(0.88);
  });

  it('实测成功率：托管档同样 2000 个种子（区间 [0.56,0.64]）', () => {
    const samples = 2000;
    let wins = 0;
    for (let seed = 1; seed <= samples; seed++) if (challenge(0, 1, 'auto', seed).ok) wins += 1;
    const measured = wins / samples;
    console.log(`托管档实测 ${wins}/${samples} = ${measured.toFixed(4)}（契约 0.60）`);
    expect(measured).toBeGreaterThanOrEqual(0.56);
    expect(measured).toBeLessThanOrEqual(0.64);
  });

  it('同种子同 N 重放结果一致（§7.2 那句「同一存档重放结果一致」的在线版）', () => {
    const first = challenge(0, 2, 'manual', 987_654_321);
    const second = challenge(0, 2, 'manual', 987_654_321);
    expect(second).toEqual(first);
  });
});
