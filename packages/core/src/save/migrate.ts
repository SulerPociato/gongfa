import { SAVE_SCHEMA_VERSION } from './schema';

// 契约 §5.2：migrate[n] 把版本 n 迁到 n+1，读档时按版本逐级上跳，不做跳跃迁移。
// v1 是当前版本，所以表是空的；等 v2 出来时往这里加一条 { 1: migrateV1toV2 }，老档就能一路迁上来。
export type Migration = (old: unknown) => unknown;

export type MigrationTable = Readonly<Record<number, Migration>>;

export const MIGRATIONS: MigrationTable = {};

export interface MigrateResult {
  ok: boolean;
  errors: string[];
  value: unknown;
  /** 读到的版本 */
  from: number | null;
  /** 迁移后的版本 */
  to: number | null;
}

// 表里能到的最高版本；空表就是本程序的原生版本。
function ceilingOf(table: MigrationTable): number {
  let top = SAVE_SCHEMA_VERSION;
  for (const key of Object.keys(table)) top = Math.max(top, Number(key) + 1);
  return top;
}

// 只吃已经过 envelope 的原始对象：这里不判字段合法性，迁完再统一校验。
export function migrate(raw: unknown, table: MigrationTable = MIGRATIONS): MigrateResult {
  const envelope = raw as { schemaVersion?: unknown } | null;
  const from = envelope !== null && typeof envelope === 'object' ? envelope.schemaVersion : undefined;
  if (typeof from !== 'number' || !Number.isInteger(from)) {
    return { ok: false, errors: [`schemaVersion: 需要整数版本号，收到 ${String(from)}`], value: raw, from: null, to: null };
  }

  const top = ceilingOf(table);
  if (from > top) {
    return { ok: false, errors: [`存档版本 ${from} 比本程序支持的版本新（本程序 ${SAVE_SCHEMA_VERSION}），请先升级游戏`], value: raw, from, to: from };
  }

  const errors: string[] = [];
  let value: unknown = raw;
  let version = from;
  while (version < top) {
    const step = table[version];
    if (step === undefined) {
      errors.push(`缺少迁移函数：无法从 ${version} 迁到 ${version + 1}`);
      return { ok: false, errors, value, from, to: version };
    }
    try {
      value = step(value);
    } catch (error) {
      errors.push(`迁移 ${version}→${version + 1} 抛出：${(error as Error).message}`);
      return { ok: false, errors, value, from, to: version };
    }
    version += 1;
  }

  return { ok: errors.length === 0, errors, value, from, to: version };
}
