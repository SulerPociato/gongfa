import { bookDecay, type BookDef, type Modifier } from '../content/books';

// 契约 §6 的功法书生命周期。相位是「装备状态 + 画布内容」的派生量（D1：dirty 不落库），
// 状态机本身不碰 UI：要不要弹确认、按钮显示什么，全是宿主的事，这里只回答「这一步合法吗、之后画布该装什么」。
export type BookPhase = 'IDLE' | 'LOADED' | 'DIRTY' | 'FROZEN';
export type BookEvent = { readonly t: 'load' } | { readonly t: 'edit' } | { readonly t: 'freeze' } | { readonly t: 'unload' } | { readonly t: 'discard' };
// 转移之后画布该装什么：book = 书原始克隆，starter = 开局程序，none = 保持现状。
export type BookReload = 'none' | 'book' | 'starter';

export interface BookTransition {
  readonly phase: BookPhase;
  readonly reload: BookReload;
  readonly errors: readonly string[];
}

export interface BookSettleDeps {
  readonly bookDecay: number;
  readonly modifiers: readonly Modifier[];
}

export interface PhaseInput {
  readonly equippedBook: string | null;
  readonly workspace: unknown;
  /** 装备那本书的原始克隆；没有装备（或表里查不到）时为 null */
  readonly bookWorkspace: unknown;
  readonly starterWorkspace: unknown;
}

// hasBook：load 事件指「目录里有这一本」，其它事件指「当前确实装备了一本解析得出来的书」。
export function bookEvent(phase: BookPhase, event: BookEvent, hasBook: boolean): BookTransition {
  const go = (next: BookPhase, reload: BookReload): BookTransition => ({ phase: next, reload, errors: [] });
  const stop = (message: string): BookTransition => ({ phase, reload: 'none', errors: [message] });

  if (event.t === 'load') {
    if (!hasBook) return stop('功法书目录里没有这本');
    // FROZEN 装书会覆盖个人程序，覆盖前确认由宿主做；状态机只管「这一步之后回到 LOADED」
    return go('LOADED', 'book');
  }
  if (event.t === 'edit') {
    if (phase === 'LOADED' || phase === 'DIRTY') return go('DIRTY', 'none');
    return stop('没有装备功法书，谈不上修改');
  }
  if (event.t === 'freeze') {
    if (phase === 'DIRTY') return go('FROZEN', 'none');
    if (phase === 'LOADED') return stop('还没改动，固化的是书原文；请先修改画布再固化');
    if (phase === 'FROZEN') return stop('已经是个人功法，无需再固化');
    return stop('未装载功法，不能固化');
  }
  if (event.t === 'unload') {
    if (phase === 'LOADED') return go('IDLE', 'starter');
    if (phase === 'DIRTY') return stop('有未固化的修改：先「放弃修改」或「固化为个人功法」，再卸下');
    return stop('没有装备功法书，无需卸下');
  }
  if (phase === 'LOADED' || phase === 'DIRTY') return go('LOADED', 'book');
  return stop('没有装备功法书，放弃修改无从谈起');
}

// 深比较 plain object / array（Blockly save() 产物只有这两种容器 + 原始值）。
// 坐标与块 id 都不进比较（COSMETIC_KEYS）：x/y 是摆放位置，id 在载入开局程序时由 Blockly 现生成
// （STARTER_WORKSPACE_JSON 根本没写 id），把它们算进差异会让「什么都没改」的画布永远被判成改过。
// 键序同样不算改动：同一份画布序列化两次可能给出不同键序，误判成 DIRTY 会让玩家白丢衰减。
const COSMETIC_KEYS: readonly string[] = ['x', 'y', 'id'];

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!COSMETIC_KEYS.includes(key)) out[key] = comparable(item);
    }
    return out;
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEqual(left[key], right[key]));
}

export function isDirty(a: unknown, b: unknown): boolean {
  return !deepEqual(comparable(a), comparable(b));
}

// 刷新后没有任何会话信息，相位只能这样复原（FROZEN 等价「无书 + 个人程序」）。
// 书解析不出来时不假装 LOADED：宁可退回 IDLE 让宿主去报目录缺失。
export function derivePhase(input: PhaseInput): BookPhase {
  if (input.equippedBook !== null) {
    if (input.bookWorkspace === null || input.bookWorkspace === undefined) return 'IDLE';
    return isDirty(input.workspace, input.bookWorkspace) ? 'DIRTY' : 'LOADED';
  }
  if (isDirty(input.workspace, input.starterWorkspace)) return 'FROZEN';
  return 'IDLE';
}

// 装备 ↔ 衰减/修正必须成对：卸下（含固化）时给一份完全中性的结算参数，
// 光把 equippedBook 置 null 而留着 modifiers，等于心魔修正永久生效。
export function bookSettleDeps(book: BookDef | null, realm: number): BookSettleDeps {
  if (book === null) return { bookDecay: 1, modifiers: [] };
  return { bookDecay: bookDecay(realm, book.realm, book.decayCoefficient), modifiers: book.modifiers };
}
