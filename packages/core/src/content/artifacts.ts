// 契约 §2.4 的道具表（玉简 / 算盘）与架构 §3.3 的 JSON 形状同一口径：只吃已解析的 JSON，core 不碰 fs，
// 读文件由宿主（apps/web 的 JSON import）负责。校验风格照 books.ts：点分路径 +「需要 X，收到 Y」，
// 一次把整份表的毛病报全再抛，helper 不跨文件复用。
import type { Modifier, ModifierKind, ModifierTarget } from './books';
import { ContentValidationError } from './schema';

const TARGETS: readonly ModifierTarget[] = ['rate', 'demonRate', 'budget', 'offlineRate', 'slot'];
const KINDS: readonly ModifierKind[] = ['mul', 'add'];

// 玉简的缓存语义：同一 tick 内第二次起执行同一 actionId 才算命中，命中折扣与命中步数都来自这张表。
// sameActionId 只认真：P0 没有别的缓存键（按参数缓存要等冲关积木带参数，属 6.6）。
export interface JadeCacheSpec {
  readonly sameActionId: true;
  readonly hitGainMultiplier: number;
  readonly hitStepCost: number;
}

export type ArtifactEffect =
  | { readonly type: 'cache'; readonly cache: JadeCacheSpec }
  | { readonly type: 'modifier'; readonly modifier: Modifier };

export interface ArtifactDef {
  readonly id: string;
  readonly name: { readonly zh: string };
  readonly effects: readonly ArtifactEffect[];
}

export interface ArtifactEquipment {
  /** 装备位里最后一件的缓存规格；没装玉简就是 null，结算侧据此决定要不要打折与免步。 */
  readonly jadeCache: JadeCacheSpec | null;
  /** 装备位里 budget 类 add modifier 的合计（同 id 只算最后一个），宿主加到 BASE_BUDGET 上。 */
  readonly budgetBonus: number;
  /** 道具提供的通用修正（rate / demonRate）：由宿主合并进 sink 的 modifiers，与功法书的修改一起结算。 */
  readonly modifiers: readonly Modifier[];
  /** 表里没有的 id、以及当前还不消费的 modifier，逐条写明原因，不静默吞掉。 */
  readonly errors: readonly string[];
}

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

// 命中折扣写成 >1 会让「缓存」变成奖励，命中步写成小数则没法和 VM 的整数步数对齐，两条都在载入时就拒。
function readCache(value: unknown, at: string, errors: string[]): JadeCacheSpec | null {
  const raw = asRecord(value, at, errors);
  const sameActionId = raw['sameActionId'];
  if (sameActionId !== true) {
    errors.push(`${at}.sameActionId: P0 只支持同 actionId 缓存，需要 true，收到 ${describe(sameActionId)}`);
    return null;
  }
  const multiplier = asNumber(raw['hitGainMultiplier'], `${at}.hitGainMultiplier`, errors);
  if (!(multiplier >= 0 && multiplier <= 1)) {
    errors.push(`${at}.hitGainMultiplier: 需要 0..1 的有限数（§2.4 是折扣不是奖励），收到 ${describe(raw['hitGainMultiplier'])}`);
  }
  const stepCost = asInteger(raw['hitStepCost'], `${at}.hitStepCost`, errors, 0);
  return { sameActionId: true, hitGainMultiplier: multiplier, hitStepCost: stepCost };
}

// 表里的 modifier 复用 books.ts 的形状，但 budget 这条通道在道具侧就要夹死：
// 它最终变成 VM 的预算池，非整数或负数会让 setBudget 抛 RangeError，那已经太晚了。
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
  if (kind === 'mul' && amount < 0) errors.push(`${at}.value: kind=mul 时不得为负，收到 ${amount}`);
  if (target === 'budget') {
    if (kind !== 'add') errors.push(`${at}.kind: target=budget 只支持 add（§2.4 的算盘是 +50），收到 ${describe(raw['kind'])}`);
    else if (!Number.isInteger(amount) || amount < 0) errors.push(`${at}.value: target=budget 需要非负整数，收到 ${describe(raw['value'])}`);
  }
  if (id === '' || target === '' || kind === '') return null;
  return { id, target: target as ModifierTarget, kind: kind as ModifierKind, value: amount };
}

function readEffect(value: unknown, at: string, errors: string[]): ArtifactEffect | null {
  const raw = asRecord(value, at, errors);
  const type = asText(raw['type'], `${at}.type`, errors);
  if (type === 'cache') {
    if (raw['cache'] === undefined) {
      errors.push(`${at}.cache: type=cache 需要缓存规格对象，收到 ${describe(raw['cache'])}`);
      return null;
    }
    const cache = readCache(raw['cache'], `${at}.cache`, errors);
    return cache === null ? null : { type: 'cache', cache };
  }
  if (type === 'modifier') {
    if (raw['modifier'] === undefined) {
      errors.push(`${at}.modifier: type=modifier 需要 modifier 对象，收到 ${describe(raw['modifier'])}`);
      return null;
    }
    const modifier = readModifier(raw['modifier'], `${at}.modifier`, errors);
    return modifier === null ? null : { type: 'modifier', modifier };
  }
  if (type !== '') errors.push(`${at}.type: 需要 cache | modifier，收到 ${describe(raw['type'])}`);
  return null;
}

function readArtifact(value: unknown, at: string, errors: string[], seenIds: Set<string>): ArtifactDef | null {
  const raw = asRecord(value, at, errors);
  const id = asText(raw['id'], `${at}.id`, errors);
  if (id !== '') {
    // 装备位与卸下都按 id 认，表里重复一行会让「卸下」少删一件
    if (seenIds.has(id)) errors.push(`${at}.id 重复: ${id}`);
    seenIds.add(id);
  }

  const name = asRecord(raw['name'], `${at}.name`, errors);
  const zh = asText(name['zh'], `${at}.name.zh`, errors);

  if (!Array.isArray(raw['effects']) || raw['effects'].length === 0) {
    errors.push(`${at}.effects: 需要非空数组，收到 ${describe(raw['effects'])}`);
  }
  const effects: ArtifactEffect[] = [];
  for (const [index, entry] of (Array.isArray(raw['effects']) ? raw['effects'] : []).entries()) {
    const effect = readEffect(entry, `${at}.effects[${index}]`, errors);
    if (effect !== null) effects.push(effect);
  }

  if (id === '' || zh === '' || effects.length === 0) return null;
  return { id, name: { zh }, effects };
}

export function loadArtifacts(raw: unknown): readonly ArtifactDef[] {
  const source = 'artifacts';
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ContentValidationError(source, ['必须是非空数组']);
  }

  const errors: string[] = [];
  const items: ArtifactDef[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const artifact = readArtifact(entry, `${source}[${index}]`, errors, seenIds);
    if (artifact !== null) items.push(artifact);
  }

  if (errors.length > 0) throw new ContentValidationError(source, errors);
  return items;
}

export function equipArtifacts(artifacts: readonly ArtifactDef[], equippedIds: readonly string[]): ArtifactEquipment {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const errors: string[] = [];
  const budgetById = new Map<string, number>();
  let jadeCache: JadeCacheSpec | null = null;
  const modifiers: Modifier[] = [];

  for (const id of equippedIds) {
    const artifact = byId.get(id);
    if (artifact === undefined) {
      errors.push(`道具 ${id} 在 content/artifacts.json 里还没有定义（现有 ${[...byId.keys()].join(' / ') || '无'}）`);
      continue;
    }
    for (const effect of artifact.effects) {
      if (effect.type === 'cache') {
        // 契约没定义两件缓存同时装备怎么叠，表里也只有一件：取最后一件，不静默相乘
        jadeCache = effect.cache;
        continue;
      }
      const modifier = effect.modifier;
      if (modifier.target !== 'budget') {
        if (modifier.target === 'rate' || modifier.target === 'demonRate') {
          modifiers.push(modifier);
          continue;
        }
        errors.push(`道具 ${artifact.id} 的 modifier ${modifier.id} 目标 ${modifier.target} 在 7A 还不消费，先报出来不算生效`);
        continue;
      }
      budgetById.set(modifier.id, modifier.value);
    }
  }

  let budgetBonus = 0;
  for (const value of budgetById.values()) budgetBonus += value;
  return { jadeCache, budgetBonus, modifiers, errors };
}
