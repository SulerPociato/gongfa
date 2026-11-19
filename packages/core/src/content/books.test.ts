import { describe, expect, it } from 'vitest';
import { bookDecay, cloneBook, loadBook, loadBooks, type BookDef } from './books';
import { ContentValidationError } from './schema';

// 表里最小可用的一份：workspace 用嵌套结构，克隆独立性只能靠嵌套证明。
const RAW = [
  {
    id: 'book_zhoutian',
    tier: 1,
    realm: 0,
    name: { zh: '周天吐纳诀' },
    workspace: { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h', inputs: { BODY: { block: { type: 'breath', id: 'b' } } } }] } },
    modifiers: [{ id: 'zhoutian_demon', target: 'demonRate', kind: 'mul', value: 0.95 }],
    decayCoefficient: 0.5,
  },
];

function books(): readonly BookDef[] {
  return loadBooks(RAW);
}

describe('功法书表（契约 §6 + 架构 §3.3 / §4）', () => {
  it('未知 id 只报错，不抛异常：宿主拿得到中文原因', () => {
    const result = loadBook(books(), 'book_nope');

    expect(result.ok).toBe(false);
    expect(result.book).toBeNull();
    expect(result.errors.join(' ')).toContain('book_nope');
  });

  it('loadBook 交回的是深拷贝：改克隆不动源，逐层无引用共享', () => {
    const source = books();
    const loaded = loadBook(source, 'book_zhoutian');
    expect(loaded.ok && loaded.book !== null).toBe(true);
    const clone = loaded.book as BookDef;

    // Blockly 的 save() 在 core 里只能是 unknown，这里只按形状取引用做对比
    type Workspace = { blocks: { languageVersion: number; blocks: Record<string, unknown>[] } };
    const nested = (value: unknown): Workspace => value as Workspace;
    const sourceWorkspace = source[0]!.workspace;
    expect(clone.workspace).not.toBe(sourceWorkspace);
    expect(nested(clone.workspace).blocks).not.toBe(nested(sourceWorkspace).blocks);
    expect(nested(clone.workspace).blocks.blocks[0]).not.toBe(nested(sourceWorkspace).blocks.blocks[0]);
    expect(nested(clone.workspace).blocks.blocks[0]!.inputs).not.toBe(nested(sourceWorkspace).blocks.blocks[0]!.inputs);
    expect(clone.modifiers).not.toBe(source[0]!.modifiers);
    expect(clone.modifiers[0]).not.toBe(source[0]!.modifiers[0]);

    nested(clone.workspace).blocks.blocks[0]!.type = 'tampered';
    clone.modifiers[0]!.value = 0.5;
    expect(nested(sourceWorkspace).blocks.blocks[0]!.type).toBe('tick_hat');
    expect(source[0]!.modifiers[0]!.value).toBe(0.95);
  });

  it('cloneBook 与 loadBook 等价：源表本身永远是只读真相', () => {
    const original = books()[0]!;
    const clone = cloneBook(original);
    expect(clone).toEqual(original);
    expect(clone).not.toBe(original);
  });

  it('bookDecay（契约 §2.2）：境界低于书 = 1，相等 = 1，+1 = 0.667，+3 = 0.4，coefficient 可换', () => {
    expect(bookDecay(0, 0)).toBe(1);
    expect(bookDecay(0, 1)).toBe(1);
    expect(bookDecay(1, 0)).toBeCloseTo(1 / 1.5, 12);
    expect(bookDecay(3, 0)).toBeCloseTo(0.4, 12);
    expect(bookDecay(1, 0, 1)).toBeCloseTo(0.5, 12);
  });

  it('表校验逐条报错：缺 decayCoefficient、kind 非 mul|add、target 越界、Modifier.id 缺失或重复', () => {
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ['缺 decayCoefficient', { ...RAW[0], decayCoefficient: undefined } as Record<string, unknown>, 'decayCoefficient'],
      ['kind 非 mul|add', { ...RAW[0], modifiers: [{ id: 'm', target: 'demonRate', kind: 'set', value: 1 }] }, 'kind'],
      ['target 越界', { ...RAW[0], modifiers: [{ id: 'm', target: 'qiRate', kind: 'mul', value: 1 }] }, 'target'],
      ['Modifier.id 缺失', { ...RAW[0], modifiers: [{ target: 'demonRate', kind: 'mul', value: 0.95 }] }, 'id'],
      ['mul 负值', { ...RAW[0], modifiers: [{ id: 'm', target: 'demonRate', kind: 'mul', value: -1 }] }, 'value'],
    ];

    for (const [label, entry, fragment] of cases) {
      expect(() => loadBooks([entry]), label).toThrow(ContentValidationError);
      try {
        loadBooks([entry]);
      } catch (error) {
        expect((error as ContentValidationError).errors.join(' '), label).toContain(fragment);
      }
    }

    // 同一本书里重复的 Modifier.id 也要挡住：成对装卸靠 id 认，重复就是装卸不对称
    expect(() => loadBooks([{ ...RAW[0], modifiers: [{ id: 'm', target: 'rate', kind: 'mul', value: 1 }, { id: 'm', target: 'demonRate', kind: 'mul', value: 0.95 }] }])).toThrow(ContentValidationError);
    // 重复的书 id 同理
    expect(() => loadBooks([RAW[0], RAW[0]])).toThrow(ContentValidationError);
  });

  it('空表 / 非数组直接报错，不静默给一本都不存在的目录', () => {
    expect(() => loadBooks([])).toThrow(ContentValidationError);
    expect(() => loadBooks({})).toThrow(ContentValidationError);
  });
});
