import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/loader';
import { bookDecay, cloneBook, loadBook, loadBooks, type BookDef } from '../content/books';
import type { ActionRequest } from '../vm/interpreter';
import { makeActionSink } from '../modifier/settle';
import { bookEvent, bookSettleDeps, derivePhase, isDirty, type BookEvent, type BookPhase } from './machine';

const CONTENT = loadContent({
  actions: [{ id: 'breath', baseGain: 1, demonDelta: 0, kind: 'gain' }],
  realms: [{ id: 0, name: { zh: '炼气' }, threshold: '1e3', passivePerSec: 0, actionMult: 1 }],
});

const BOOKS = loadBooks([
  {
    id: 'book_zhoutian',
    tier: 1,
    realm: 0,
    name: { zh: '周天吐纳诀' },
    workspace: { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h', inputs: { BODY: { block: { type: 'breath', id: 'b' } } } }] } },
    modifiers: [{ id: 'zhoutian_demon', target: 'demonRate', kind: 'mul', value: 0.95 }],
    decayCoefficient: 0.5,
  },
]);

const first = loadBook(BOOKS, 'book_zhoutian');
if (!first.ok || first.book === null) throw new Error('功法书表没装起来，后面的用例都无从谈起');
const BOOK: BookDef = first.book;
const BOOK_WORKSPACE = { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h', inputs: { BODY: { block: { type: 'breath', id: 'b' } } } }] } };
const STARTER = { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 's' }] } };
// 在书原文基础上把吐纳换成调息：代表玩家动过画布
const MODIFIED = { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h', inputs: { BODY: { block: { type: 'calm', id: 'b' } } } }] } };

function req(k: number, loopDepth = 0): ActionRequest {
  return { actionId: 'breath', k, pc: 0, loopDepth };
}

const PHASES: BookPhase[] = ['IDLE', 'LOADED', 'DIRTY', 'FROZEN'];
const EVENTS: BookEvent[] = [{ t: 'load' }, { t: 'edit' }, { t: 'freeze' }, { t: 'unload' }, { t: 'discard' }];

describe('bookEvent 状态机（契约 §6）', () => {
  it('⑥ 转移表逐格钉死：4 phase × 5 event，合法格给去向，非法格给原因', () => {
    const table: Readonly<Record<BookPhase, Readonly<Record<BookEvent['t'], { phase: BookPhase; reload: 'none' | 'book' | 'starter'; errors?: string }>>>> = {
      IDLE: {
        load: { phase: 'LOADED', reload: 'book' },
        edit: { phase: 'IDLE', reload: 'none', errors: '没有装备功法书，谈不上修改' },
        freeze: { phase: 'IDLE', reload: 'none', errors: '未装载功法，不能固化' },
        unload: { phase: 'IDLE', reload: 'none', errors: '没有装备功法书，无需卸下' },
        discard: { phase: 'IDLE', reload: 'none', errors: '没有装备功法书，放弃修改无从谈起' },
      },
      LOADED: {
        load: { phase: 'LOADED', reload: 'book' },
        edit: { phase: 'DIRTY', reload: 'none' },
        freeze: { phase: 'LOADED', reload: 'none', errors: '还没改动，固化的是书原文；请先修改画布再固化' },
        unload: { phase: 'IDLE', reload: 'starter' },
        discard: { phase: 'LOADED', reload: 'book' },
      },
      DIRTY: {
        load: { phase: 'LOADED', reload: 'book' },
        edit: { phase: 'DIRTY', reload: 'none' },
        freeze: { phase: 'FROZEN', reload: 'none' },
        unload: { phase: 'DIRTY', reload: 'none', errors: '有未固化的修改：先「放弃修改」或「固化为个人功法」，再卸下' },
        discard: { phase: 'LOADED', reload: 'book' },
      },
      FROZEN: {
        load: { phase: 'LOADED', reload: 'book' },
        edit: { phase: 'FROZEN', reload: 'none', errors: '没有装备功法书，谈不上修改' },
        freeze: { phase: 'FROZEN', reload: 'none', errors: '已经是个人功法，无需再固化' },
        unload: { phase: 'FROZEN', reload: 'none', errors: '没有装备功法书，无需卸下' },
        discard: { phase: 'FROZEN', reload: 'none', errors: '没有装备功法书，放弃修改无从谈起' },
      },
    };

    for (const phase of PHASES) {
      for (const event of EVENTS) {
        const want = table[phase][event.t];
        const got = bookEvent(phase, event, true);
        const key = `${phase}+${event.t}`;
        expect(got.phase, key).toBe(want.phase);
        expect(got.reload, key).toBe(want.reload);
        if (want.errors === undefined) expect(got.errors, key).toEqual([]);
        else expect(got.errors, key).toEqual([want.errors]);
      }
    }
  });

  it('转移原因里必须带上玩家能看懂的动作词', () => {
    expect(bookEvent('DIRTY', { t: 'unload' }, true).errors[0]).toContain('放弃修改');
    expect(bookEvent('IDLE', { t: 'freeze' }, true).errors[0]).toContain('固化');
    expect(bookEvent('LOADED', { t: 'freeze' }, true).errors[0]).toContain('固化');
  });

  it('load 时目录里没有这本：留在原相位并报明确原因', () => {
    expect(bookEvent('IDLE', { t: 'load' }, false)).toEqual({ phase: 'IDLE', reload: 'none', errors: ['功法书目录里没有这本'] });
    expect(bookEvent('FROZEN', { t: 'load' }, false).errors[0]).toContain('目录');
    // 非 load 事件不查目录：hasBook=false 也不该把它们变成「目录缺失」
    expect(bookEvent('LOADED', { t: 'unload' }, false).errors).toEqual([]);
  });

  it('⑨⑩ 卸下回开局程序；放弃修改回书原文（LOADED / DIRTY 两个起点都要有退路）', () => {
    expect(bookEvent('LOADED', { t: 'unload' }, true)).toEqual({ phase: 'IDLE', reload: 'starter', errors: [] });
    expect(bookEvent('LOADED', { t: 'discard' }, true)).toEqual({ phase: 'LOADED', reload: 'book', errors: [] });
    expect(bookEvent('DIRTY', { t: 'discard' }, true)).toEqual({ phase: 'LOADED', reload: 'book', errors: [] });
  });

  it('FROZEN 装载 = 覆盖个人程序（弹窗由宿主在调用前问，状态机不掺 UI）', () => {
    expect(bookEvent('FROZEN', { t: 'load' }, true)).toEqual({ phase: 'LOADED', reload: 'book', errors: [] });
  });
});

describe('isDirty / derivePhase（D1：dirty 不落库，当场推导）', () => {
  it('⑦ 深比较：键序不算改动，字段值 / 数组顺序 / null≠undefined 才算', () => {
    expect(isDirty(BOOK_WORKSPACE, BOOK_WORKSPACE)).toBe(false);
    expect(isDirty(cloneBook(BOOK).workspace, BOOK_WORKSPACE)).toBe(false);
    expect(isDirty({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(isDirty({ a: 1 }, { a: 2 })).toBe(true);
    expect(isDirty([1, 2], [2, 1])).toBe(true);
    expect(isDirty({ blocks: { blocks: [] } }, { blocks: [] })).toBe(true);
    expect(isDirty({ a: null }, { a: undefined })).toBe(true);
    expect(isDirty(null, undefined)).toBe(true);
    expect(isDirty(BOOK_WORKSPACE, MODIFIED)).toBe(true);
  });

  it('坐标与块 id 不算改动：开局程序没有 id，载入后 Blockly 现生成一个', () => {
    const starterLiteral = { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', x: 32, y: 32 }] } };
    const starterAfterLoad = { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'aBcDeF', x: 180, y: 60 }] } };
    expect(isDirty(starterAfterLoad, starterLiteral)).toBe(false);
    expect(isDirty(starterLiteral, { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'aBcDeF', x: 32, y: 32 }, { type: 'breath', id: 'gHi' }] } })).toBe(true);
  });

  it('⑪ 刷新复原：相位只由 equipped + 画布内容推出', () => {
    const idle = { equippedBook: null, workspace: STARTER, bookWorkspace: null, starterWorkspace: STARTER };
    expect(derivePhase(idle)).toBe('IDLE');
    // 卸下书时画布会被换成开局程序；这里 workspace 恰好还是书原文但没装备 → 按「个人程序」算，
    // IDLE 的唯一判据是「画布 == 开局程序」，不看它和某本书长得像不像。
    expect(derivePhase({ ...idle, workspace: BOOK_WORKSPACE, bookWorkspace: BOOK_WORKSPACE })).toBe('FROZEN');
    expect(derivePhase({ ...idle, workspace: MODIFIED })).toBe('FROZEN');
    expect(derivePhase({ equippedBook: 'book_zhoutian', workspace: BOOK_WORKSPACE, bookWorkspace: BOOK_WORKSPACE, starterWorkspace: STARTER })).toBe('LOADED');
    expect(derivePhase({ equippedBook: 'book_zhoutian', workspace: MODIFIED, bookWorkspace: BOOK_WORKSPACE, starterWorkspace: STARTER })).toBe('DIRTY');
    // 书解析不出来（表被改坏）不能假装 LOADED
    expect(derivePhase({ equippedBook: 'book_zhoutian', workspace: BOOK_WORKSPACE, bookWorkspace: null, starterWorkspace: STARTER })).toBe('IDLE');
  });

  it('derivePhase 与 bookEvent 闭环：DIRTY 固化后 equipped 清空，推出 FROZEN', () => {
    const before = derivePhase({ equippedBook: 'book_zhoutian', workspace: MODIFIED, bookWorkspace: BOOK_WORKSPACE, starterWorkspace: STARTER });
    const next = bookEvent(before, { t: 'freeze' }, true);
    expect(next).toEqual({ phase: 'FROZEN', reload: 'none', errors: [] });
    const after = derivePhase({ equippedBook: null, workspace: MODIFIED, bookWorkspace: BOOK_WORKSPACE, starterWorkspace: STARTER });
    expect(after).toBe('FROZEN');
  });

  it('衰减与克隆口径在这里也钉住：书境界 0 + 玩家境界 1 → 2/3；clone 是独立副本', () => {
    expect(bookDecay(1, BOOK.realm, BOOK.decayCoefficient)).toBeCloseTo(2 / 3, 12);
    const clone = cloneBook(BOOK);
    expect(clone).toEqual(BOOK);
    expect(clone.workspace).not.toBe(BOOK.workspace);
  });
});

describe('装备 ↔ 成对装卸（契约 §4「移除来源时成对移除」）', () => {
  it('⑧ 装载 → 固化：demon 增长率必须回到中性，不是只看 equippedBook=null', () => {
    const equipped = bookSettleDeps(BOOK, 0);
    expect(equipped).toEqual({ bookDecay: 1, modifiers: [{ id: 'zhoutian_demon', target: 'demonRate', kind: 'mul', value: 0.95 }] });
    const withBook = makeActionSink({ content: CONTENT, realmIndex: 0, ...equipped }).execute(req(1));
    // §2.2.1 增长 0.00005 × 0.95（O1 先加后乘；动作自身 demonDelta = 0）
    expect(withBook.demonDelta).toBeCloseTo(0.0000475, 12);
    expect(withBook.qi).toBe(1);

    // 固化 = 卸下书：decay 与 modifiers 一起清零，动作产出不再衰减
    const neutral = bookSettleDeps(null, 0);
    expect(neutral).toEqual({ bookDecay: 1, modifiers: [] });
    const afterFreeze = makeActionSink({ content: CONTENT, realmIndex: 0, ...neutral }).execute(req(1));
    expect(afterFreeze.demonDelta).toBeCloseTo(0.00005, 12);
    expect(afterFreeze.demonDelta / withBook.demonDelta).toBeCloseTo(1 / 0.95, 12);
  });

  it('境界上去之后衰减才动：筑基 × 书炼气 → qi 乘 2/3，demon 不受衰减（契约 §6）', () => {
    const realm1 = loadContent({
      actions: [{ id: 'breath', baseGain: 1, demonDelta: 0, kind: 'gain' }],
      realms: [
        { id: 0, name: { zh: '炼气' }, threshold: '1e3', passivePerSec: 0, actionMult: 1 },
        { id: 1, name: { zh: '筑基' }, threshold: '2e4', passivePerSec: 5, actionMult: 3 },
      ],
    });
    const deps = bookSettleDeps(BOOK, 1);
    expect(deps.bookDecay).toBeCloseTo(2 / 3, 12);
    const sink = makeActionSink({ content: realm1, realmIndex: 1, ...deps });
    expect(sink.execute(req(1)).qi).toBeCloseTo(3 * (2 / 3), 12);
    expect(sink.execute(req(1)).demonDelta).toBeCloseTo(0.00005 * 0.95, 12);
  });
});
