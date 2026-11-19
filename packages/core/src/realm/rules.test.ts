import { describe, expect, it } from 'vitest';
import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import { loadContent } from '../content/loader';
import { bookSettleDeps } from '../book/machine';
import { loadBook, loadBooks, type BookDef } from '../content/books';
import { TICKS_PER_SEC } from '../types';
import type { ActionRequest } from '../vm/interpreter';
import { makeActionSink } from '../modifier/settle';
import zhoutianJson from '../../../../content/books/book_zhoutian.json';
import { breakthrough, isThresholdReached, passivePerTick } from './rules';

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

describe('突破门槛（本轮简化：存量 ≥ 阈值即可，渡劫挑战在任务 6.5）', () => {
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
