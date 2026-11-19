import { ContentValidationError } from './schema';

// 架构 §3.3 的 book JSON 与 §4 的 Modifier 形状。只吃已解析的 JSON：core 不碰 fs，
// 读文件由宿主（apps/web 的 JSON import）或 tools 脚本负责，口径与 content/loader.ts 一致。
// 校验风格也照 loader.ts：点分路径 + 「需要 X，收到 Y」，一次把整份表的毛病报全再抛。
// helper 不跨文件复用（loader.ts 的那些是私有的），宁可在本文件重复几个小函数。
export type ModifierTarget = 'rate' | 'demonRate' | 'budget' | 'offlineRate' | 'slot';
export type ModifierKind = 'mul' | 'add';

// Modifier 字段可写是刻意的：架构 §4 给的就是可变结构，深拷贝独立性也只能靠「改了副本、源不变」证明。
export interface Modifier {
  id: string;
  target: ModifierTarget;
  kind: ModifierKind;
  value: number;
}

// tier 是元数据（D6 批准：不参与任何计算），realm 才是衰减的锚点。
export interface BookDef {
  readonly id: string;
  readonly tier: number;
  readonly realm: number;
  readonly name: { readonly zh: string };
  readonly workspace: unknown;
  readonly modifiers: readonly Modifier[];
  readonly decayCoefficient: number;
}

export interface BookLoadResult {
  readonly ok: boolean;
  readonly book: BookDef | null;
  readonly errors: readonly string[];
}

const TARGETS: readonly ModifierTarget[] = ['rate', 'demonRate', 'budget', 'offlineRate', 'slot'];
const KINDS: readonly ModifierKind[] = ['mul', 'add'];

function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function asRecord(value: unknown, at: string, errors: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${at}: 需要对象，收到 ${describe(value)}`);
    return {};
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, at: string, errors: string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${at}: 需要非空字符串，收到 ${describe(value)}`);
    return '';
  }
  return value.trim();
}

// 整数下限：书表里 realm / tier 都是境界或档位序号，负数没有意义。
function asInteger(value: unknown, at: string, errors: string[], min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    errors.push(`${at}: 需要 ≥ ${min} 的整数，收到 ${describe(value)}`);
    return min;
  }
  return value;
}

function asNumber(value: unknown, at: string, errors: string[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${at}: 需要有限数字，收到 ${describe(value)}`);
    return 0;
  }
  return value;
}

function readModifier(value: unknown, at: string, errors: string[]): Modifier | null {
  const raw = asRecord(value, at, errors);
  const id = asText(raw['id'], `${at}.id`, errors);
  const target = asText(raw['target'], `${at}.target`, errors);
  if (target !== '' && !TARGETS.includes(target as ModifierTarget)) {
    errors.push(`${at}.target: 需要 ${TARGETS.join(' | ')}，收到 ${describe(raw['target'])}`);
  }
  const kind = asText(raw['kind'], `${at}.kind`, errors);
  if (kind !== '' && !KINDS.includes(kind as ModifierKind)) {
    errors.push(`${at}.kind: 需要 ${KINDS.join(' | ')}，收到 ${describe(raw['kind'])}`);
  }
  const amount = asNumber(raw['value'], `${at}.value`, errors);
  // mul 为负会把灵力算成反向（加法刷成倒扣），宁可当坏表；上限与夹取在 settle.resolveModifiers 判
  if (kind === 'mul' && amount < 0) errors.push(`${at}.value: kind=mul 时不得为负，收到 ${amount}`);
  if (id === '' || target === '' || kind === '') return null;
  return { id, target: target as ModifierTarget, kind: kind as ModifierKind, value: amount };
}

export function loadBooks(raw: unknown): readonly BookDef[] {
  const source = 'books';
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ContentValidationError(source, ['必须是非空数组']);
  }

  const items: BookDef[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const at = `${source}[${index}]`;
    const book = readBook(entry, at, errors, seenIds);
    if (book !== null) items.push(book);
  }

  if (errors.length > 0) throw new ContentValidationError(source, errors);
  return items;
}

function readBook(value: unknown, at: string, errors: string[], seenIds: Set<string>): BookDef | null {
  const raw = asRecord(value, at, errors);

  const id = asText(raw['id'], `${at}.id`, errors);
  if (id !== '') {
    if (seenIds.has(id)) errors.push(`${at}.id 重复: ${id}`);
    seenIds.add(id);
  }

  const tier = asInteger(raw['tier'], `${at}.tier`, errors, 1);
  const realm = asInteger(raw['realm'], `${at}.realm`, errors, 0);

  const name = asRecord(raw['name'], `${at}.name`, errors);
  const zh = asText(name['zh'], `${at}.name.zh`, errors);

  if (!('workspace' in raw) || raw['workspace'] === null) errors.push(`${at}.workspace: 需要 Blockly 的 save() 产物，收到 ${describe(raw['workspace'])}`);

  const modifierEntries = Array.isArray(raw['modifiers']) ? raw['modifiers'] : null;
  if (modifierEntries === null) {
    errors.push(`${at}.modifiers: 需要数组（可以为空），收到 ${describe(raw['modifiers'])}`);
  }
  const modifiers: Modifier[] = [];
  const modifierIds = new Set<string>();
  for (const [index, entry] of (modifierEntries ?? []).entries()) {
    const modifier = readModifier(entry, `${at}.modifiers[${index}]`, errors);
    if (modifier === null) continue;
    // 成对装卸靠 id 认：一本书里重复的 id 会让「卸下」少删一条
    if (modifierIds.has(modifier.id)) errors.push(`${at}.modifiers[${index}].id 重复: ${modifier.id}`);
    modifierIds.add(modifier.id);
    modifiers.push(modifier);
  }

  if (typeof raw['decayCoefficient'] !== 'number' || !Number.isFinite(raw['decayCoefficient']) || raw['decayCoefficient'] < 0) {
    errors.push(`${at}.decayCoefficient: 需要 ≥ 0 的有限数（契约 §2.2 mult = 1 / (1 + coefficient × Δrealm)，Δrealm < 0 已在 §6 夹 0），收到 ${describe(raw['decayCoefficient'])}`);
  }

  if (id === '' || zh === '') return null;
  return { id, tier, realm, name: { zh }, workspace: raw['workspace'], modifiers, decayCoefficient: raw['decayCoefficient'] as number };
}

// 深拷贝只走 plain object / array：Blockly 的 save() 产物里没有 Date、Map 之类的东西，
// 遇到别的类型直接返回原值，不猜（拷贝留白比拷错更诚实）。
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = deepClone(item);
    return out as unknown as T;
  }
  return value;
}

export function cloneBook(book: BookDef): BookDef {
  return {
    id: book.id,
    tier: book.tier,
    realm: book.realm,
    name: { zh: book.name.zh },
    workspace: deepClone(book.workspace),
    modifiers: book.modifiers.map((modifier) => ({ ...modifier })),
    decayCoefficient: book.decayCoefficient,
  };
}

// 装载口径（契约 §6「装载 = 深拷贝书 workspace」）：交回的一律是副本，目录本体保持只读真相。
export function loadBook(books: readonly BookDef[], id: string): BookLoadResult {
  const book = books.find((entry) => entry.id === id);
  if (book === undefined) {
    return { ok: false, book: null, errors: [`功法书目录里没有 id「${id}」的条目`] };
  }
  return { ok: true, book: cloneBook(book), errors: [] };
}

// 契约 §2.2：mult = 1 / (1 + coefficient × max(0, realm − bookRealm))。
// Δrealm < 0 夹 0（低境界拿不到高境界的书时不能反向放大）。
export function bookDecay(realm: number, bookRealm: number, coefficient = 0.5): number {
  return 1 / (1 + coefficient * Math.max(0, realm - bookRealm));
}
