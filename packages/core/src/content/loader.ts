import { Qi } from '../number/bignum';
import type { ActionDef, ActionKind, Content, RealmDef } from './schema';
import { ContentValidationError } from './schema';

const ACTION_KINDS: readonly ActionKind[] = ['gain', 'calm', 'other'];
const ENTRY_REALM_ID = 0;

// 只接受已解析的 JSON：core 不碰 fs / path，读取由调用方（tools/balance-sim.ts）负责。
export function loadContent(raw: { actions: unknown; realms: unknown }): Content {
  return { actions: readActions(raw.actions), realms: readRealms(raw.realms) };
}

function fail(source: string, errors: string[]): never {
  throw new ContentValidationError(source, errors);
}

function asEntries(value: unknown, source: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) fail(source, ['必须是非空数组']);
  return value;
}

function asRecord(value: unknown, at: string, errors: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${at}: 需要对象，收到 ${JSON.stringify(value)}`);
    return {};
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, at: string, errors: string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${at}: 需要非空字符串，收到 ${JSON.stringify(value)}`);
    return '';
  }
  return value.trim();
}

function asFinite(value: unknown, at: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${at}: 需要有限数字，收到 ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

function asBounded(value: unknown, at: string, errors: string[], min: number): number {
  const got = asFinite(value, at, errors);
  if (got === undefined) return min;
  if (got < min) {
    errors.push(`${at}: 需要 ≥ ${min}，收到 ${got}`);
    return min;
  }
  return got;
}

function asInteger(value: unknown, at: string, errors: string[], min: number): number {
  const got = asBounded(value, at, errors, min);
  if (!Number.isInteger(got)) {
    errors.push(`${at}: 需要整数，收到 ${got}`);
    return min;
  }
  return got;
}

function asEnum(value: unknown, at: string, errors: string[], allowed: readonly string[]): string {
  const got = asText(value, at, errors);
  if (got !== '' && !allowed.includes(got)) {
    errors.push(`${at}: 需要 ${allowed.join(' | ')}，收到 ${got}`);
  }
  return got;
}

// threshold 按架构 §3.4 以数字字符串书写（"1e3"），与 Qi 的序列化口径一致；裸数字同样接受。
function asQi(value: unknown, at: string, errors: string[]): Qi | undefined {
  if (typeof value === 'number') return asFinite(value, at, errors);
  if (typeof value === 'string') {
    try {
      return Qi.parse(value);
    } catch {
      errors.push(`${at}: 无法解析为数字，收到 ${JSON.stringify(value)}`);
      return undefined;
    }
  }
  errors.push(`${at}: 需要数字或数字字符串，收到 ${JSON.stringify(value)}`);
  return undefined;
}

function readActions(value: unknown): readonly ActionDef[] {
  const source = 'actions.json';
  const errors: string[] = [];
  const items: ActionDef[] = [];
  const seenIds = new Set<string>();

  for (const [index, entry] of asEntries(value, source).entries()) {
    const at = `${source}[${index}]`;
    const raw = asRecord(entry, at, errors);

    const id = asText(raw['id'], `${at}.id`, errors);
    if (id !== '') {
      if (seenIds.has(id)) errors.push(`${at}.id 重复: ${id}`);
      seenIds.add(id);
    }

    const kind = asEnum(raw['kind'], `${at}.kind`, errors, ACTION_KINDS) as ActionKind;
    const baseGain = asBounded(raw['baseGain'], `${at}.baseGain`, errors, 0);
    const demonDelta = asFinite(raw['demonDelta'], `${at}.demonDelta`, errors) ?? 0;

    items.push({ id, baseGain, demonDelta, kind });
  }

  if (errors.length > 0) fail(source, errors);
  return items;
}

function readRealms(value: unknown): readonly RealmDef[] {
  const source = 'realms.json';
  const errors: string[] = [];
  const items: RealmDef[] = [];
  const seenIds = new Set<number>();

  for (const [index, entry] of asEntries(value, source).entries()) {
    const at = `${source}[${index}]`;
    const raw = asRecord(entry, at, errors);

    const id = asInteger(raw['id'], `${at}.id`, errors, ENTRY_REALM_ID);
    if (seenIds.has(id)) errors.push(`${at}.id 重复: ${id}`);
    seenIds.add(id);

    const name = asRecord(raw['name'], `${at}.name`, errors);
    const zh = asText(name['zh'], `${at}.name.zh`, errors);

    const beforeThreshold = errors.length;
    const threshold = asQi(raw['threshold'], `${at}.threshold`, errors) ?? Qi.zero;
    if (errors.length === beforeThreshold && Qi.cmp(threshold, Qi.zero) <= 0) {
      errors.push(`${at}.threshold: 需要 > 0，收到 ${threshold}`);
    }

    const passivePerSec = asBounded(raw['passivePerSec'], `${at}.passivePerSec`, errors, 0);
    const actionMult = asBounded(raw['actionMult'], `${at}.actionMult`, errors, 1);

    items.push({ id, name: { zh }, threshold, passivePerSec, actionMult });
  }

  let previous: RealmDef | undefined;
  for (const [index, current] of items.entries()) {
    if (previous === undefined) {
      if (current.id !== ENTRY_REALM_ID) errors.push(`${source}: 首个境界必须是 id ${ENTRY_REALM_ID}（炼气）`);
    } else {
      if (current.id <= previous.id) {
        errors.push(`${source}[${index}].id: 必须严格递增（${previous.id} → ${current.id}）`);
      }
      if (Qi.cmp(current.threshold, previous.threshold) <= 0) {
        errors.push(`${source}[${index}].threshold: 必须严格递增（${previous.threshold} → ${current.threshold}）`);
      }
      if (current.actionMult < previous.actionMult) {
        errors.push(`${source}[${index}].actionMult: 不得回退（${previous.actionMult} → ${current.actionMult}）`);
      }
    }
    previous = current;
  }

  if (errors.length > 0) fail(source, errors);
  return items;
}
