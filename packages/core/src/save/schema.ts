import { BASE_BUDGET } from '../types';
import { Qi } from '../number/bignum';
import { OP_TAGS, type Program } from '../vm/program';

// 契约 §5.1 存档 v1 的 schema、工厂与校验。类型定义在本文件，core/src/types.ts 只做 re-export 聚合。
export const SAVE_SCHEMA_VERSION = 1;

// workspace 原样存 Blockly 的 save() 产物：core 不 import Blockly，所以只能是 unknown。
// 真相源是 workspace，programs 只是编译缓存（读档时用 workspace 重编译）。
export interface GameState {
  schemaVersion: number;
  seed: number;
  realm: number;
  qi: string;
  demon: number;
  workspace: unknown;
  programs: Program[];
  budgetPool: number;
  computeLimit: number | null;
  ownedBooks: string[];
  equippedBook: string | null;
  ownedArtifacts: string[];
  equippedArtifacts: string[];
  offlineRate: number;
  stats: { totalQi: string; breakthroughs: number; playMs: number };
  lastSeenAt: number;
  speed: number;
  chargeReadyAt: number;
}

export interface SaveFile {
  schemaVersion: number;
  savedAt: number;
  state: GameState;
}

// 点分路径与 content/loader、verifier 同一口径（state.realm / state.stats.playMs），HUD 直接显示原文。
export interface SaveIssue {
  path: string;
  message: string;
}

export interface StateResult {
  ok: boolean;
  errors: SaveIssue[];
  state: GameState | null;
}

export interface SaveResult {
  ok: boolean;
  errors: SaveIssue[];
  save: SaveFile | null;
}

export interface EnvelopeResult {
  ok: boolean;
  errors: string[];
  schemaVersion: number | null;
  raw: Record<string, unknown> | null;
}

export const SPEED_VALUES: readonly number[] = [1, 2, 3];
// 契约 §5.1：realm 是 0..8（炼气/筑基/金丹/元婴/化神/炼虚/合体/大乘/渡劫）。
// 2026-11-26 从 4 境扩到 9 境；旧档 0..3 仍合法，不需要迁移。
export const REALM_MAX = 8;

export function issueText(issue: SaveIssue): string {
  return `${issue.path}: ${issue.message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 存档文本来自外部（localStorage / 玩家手改），报错先截断，防止整段 JSON 刷进 HUD。
function describe(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function formatSave(save: SaveFile): string {
  return JSON.stringify(save);
}

function newEnvelope(now: number, state: GameState): SaveFile {
  return { schemaVersion: SAVE_SCHEMA_VERSION, savedAt: now, state };
}

function checkInteger(value: unknown, path: string, errors: SaveIssue[], bounds: { min: number; max?: number }): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    errors.push({ path, message: `需要整数，收到 ${describe(value)}` });
    return;
  }
  const { min, max } = bounds;
  if (value < min || (max !== undefined && value > max)) {
    errors.push({ path, message: `需要在 ${max === undefined ? `≥ ${min}` : `${min}–${max}`} 内，收到 ${value}` });
  }
}

function checkNonNegative(value: unknown, path: string, errors: SaveIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push({ path, message: `需要 ≥ 0 的有限数，收到 ${describe(value)}` });
  }
}

function checkQiText(value: unknown, path: string, errors: SaveIssue[]): void {
  if (typeof value !== 'string') {
    errors.push({ path, message: `需要字符串，收到 ${describe(value)}` });
    return;
  }
  // 契约 §5.1 把 qi 存成字符串；解析口径与读档一致：Qi.parse，NaN 即坏档。
  // 序列化只能 String(qi)，不能走 Qi.format（非整数会变 3 位有效数字的科学计数，有损）。
  try {
    Qi.parse(value);
  } catch (error) {
    errors.push({ path, message: `需要可解析的有限数，收到 ${describe(value)}（${(error as Error).message}）` });
  }
}

function checkStringArray(value: unknown, path: string, errors: SaveIssue[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push({ path, message: `需要字符串数组，收到 ${describe(value)}` });
    return [];
  }
  return value as string[];
}

// programs 只是缓存，读档时不用，但形状要挡住：坏成非数组说明整份档都不可信。
function checkPrograms(value: unknown, path: string, errors: SaveIssue[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: `需要数组（编译缓存），收到 ${describe(value)}` });
    return;
  }
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ path: at, message: `需要对象，收到 ${describe(entry)}` });
      return;
    }
    if (typeof entry.id !== 'string') errors.push({ path: `${at}.id`, message: `需要字符串，收到 ${describe(entry.id)}` });
    if (!Array.isArray(entry.code)) {
      errors.push({ path: `${at}.code`, message: `需要数组，收到 ${describe(entry.code)}` });
      return;
    }
    entry.code.forEach((op, opIndex) => {
      const tag = isRecord(op) ? op.op : undefined;
      if (typeof tag !== 'string' || !OP_TAGS.includes(tag as (typeof OP_TAGS)[number])) {
        errors.push({ path: `${at}.code[${opIndex}].op`, message: `需要已知指令，收到 ${describe(op)}` });
      }
    });
  });
}

// 契约 §5.2 第 3 步：结构校验 + 业务不变量（realm ∈ 0..3、demon ∈ 0..1、equipped ⊆ owned）。
// workspace 的内容不在这里判：core 不认识 Blockly，形状问题留给 compile 阶段。
export function validateGameState(value: unknown): StateResult {
  const errors: SaveIssue[] = [];
  if (!isRecord(value)) {
    errors.push({ path: 'state', message: `需要对象，收到 ${describe(value)}` });
    return { ok: false, errors, state: null };
  }
  const state = value;

  checkInteger(state.schemaVersion, 'state.schemaVersion', errors, { min: 1 });
  checkInteger(state.seed, 'state.seed', errors, { min: 0 });
  checkInteger(state.realm, 'state.realm', errors, { min: 0, max: REALM_MAX });
  checkQiText(state.qi, 'state.qi', errors);
  if (typeof state.demon !== 'number' || !Number.isFinite(state.demon) || state.demon < 0 || state.demon > 1) {
    errors.push({ path: 'state.demon', message: `需要 0–1 之间的有限数（契约 §1 心魔存 0～1），收到 ${describe(state.demon)}` });
  }

  checkPrograms(state.programs, 'state.programs', errors);
  checkInteger(state.budgetPool, 'state.budgetPool', errors, { min: 0 });
  if (state.computeLimit === null || state.computeLimit === undefined) {
    if (state.computeLimit === undefined) errors.push({ path: 'state.computeLimit', message: '需要显式的 null（P0 不启用算力限制）' });
  } else {
    checkNonNegative(state.computeLimit, 'state.computeLimit', errors);
  }

  const ownedBooks = checkStringArray(state.ownedBooks, 'state.ownedBooks', errors);
  const ownedArtifacts = checkStringArray(state.ownedArtifacts, 'state.ownedArtifacts', errors);
  if (state.equippedBook !== null) {
    if (typeof state.equippedBook !== 'string') {
      errors.push({ path: 'state.equippedBook', message: `需要字符串或 null，收到 ${describe(state.equippedBook)}` });
    } else if (!ownedBooks.includes(state.equippedBook)) {
      // 拥有 ≠ 装备（契约 §5.1）：装备了一本没拥有的书就是改档
      errors.push({ path: 'state.equippedBook', message: `需要 ⊆ state.ownedBooks，收到 ${describe(state.equippedBook)}` });
    }
  }
  const equippedArtifacts = checkStringArray(state.equippedArtifacts, 'state.equippedArtifacts', errors);
  for (const id of equippedArtifacts) {
    if (!ownedArtifacts.includes(id)) errors.push({ path: 'state.equippedArtifacts', message: `需要 ⊆ state.ownedArtifacts，收到 ${describe(id)}` });
  }

  if (typeof state.offlineRate !== 'number' || !Number.isFinite(state.offlineRate) || state.offlineRate <= 0 || state.offlineRate > 1) {
    errors.push({ path: 'state.offlineRate', message: `需要 0（不含）–1 之间的有限数，收到 ${describe(state.offlineRate)}` });
  }

  if (!isRecord(state.stats)) {
    errors.push({ path: 'state.stats', message: `需要对象，收到 ${describe(state.stats)}` });
  } else {
    checkQiText(state.stats.totalQi, 'state.stats.totalQi', errors);
    checkInteger(state.stats.breakthroughs, 'state.stats.breakthroughs', errors, { min: 0 });
    // 负时长说明 lastSeenAt 被改坏或时钟回拨，读档后离线结算会倒扣灵力
    checkNonNegative(state.stats.playMs, 'state.stats.playMs', errors);
  }

  checkNonNegative(state.lastSeenAt, 'state.lastSeenAt', errors);
  if (typeof state.speed !== 'number' || !SPEED_VALUES.includes(state.speed)) {
    errors.push({ path: 'state.speed', message: `需要 ${SPEED_VALUES.join('/')} 之一，收到 ${describe(state.speed)}` });
  }
  // 蓄势用真实时间（契约 §7.3），未完成时是未来时间戳，只要求非负
  checkNonNegative(state.chargeReadyAt, 'state.chargeReadyAt', errors);

  if (errors.length > 0) return { ok: false, errors, state: null };
  return { ok: true, errors: [], state: value as unknown as GameState };
}

export function validateSave(value: unknown): SaveResult {
  const errors: SaveIssue[] = [];
  if (!isRecord(value)) {
    errors.push({ path: 'envelope', message: `需要对象，收到 ${describe(value)}` });
    return { ok: false, errors, save: null };
  }
  checkInteger(value.schemaVersion, 'schemaVersion', errors, { min: 1 });
  checkNonNegative(value.savedAt, 'savedAt', errors);
  const stateResult = validateGameState(value.state);
  errors.push(...stateResult.errors);
  if (errors.length > 0) return { ok: false, errors, save: null };
  return { ok: true, errors: [], save: value as unknown as SaveFile };
}

// 契约 §5.2 第 1 步：只解析 schemaVersion，其余字段在读到最终版本之前一律不解释。
export function parseEnvelope(text: string): EnvelopeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`envelope: 不是合法 JSON（${(error as Error).message}）`], schemaVersion: null, raw: null };
  }
  if (!isRecord(parsed)) return { ok: false, errors: [`envelope: 顶层需要对象，收到 ${describe(parsed)}`], schemaVersion: null, raw: null };
  const version = parsed.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, errors: [`schemaVersion: 需要整数版本号，收到 ${describe(version)}`], schemaVersion: null, raw: null };
  }
  return { ok: true, errors: [], schemaVersion: version, raw: parsed };
}

// 新档的 18 个字段一个都不能缺。seed 由调用方注入（web 侧 crypto.getRandomValues）：
// 写死 0 会让接上 RNG 之后所有玩家共用同一随机序列，是埋在未来的坑。
// ownedBooks 是开局赠书（任务 5B：《周天吐纳诀》）；装备位仍然留空，拥有 ≠ 装备（契约 §5.1）。
export function newGameState(input: { seed: number; workspace: unknown; now: number; ownedBooks?: readonly string[] | undefined }): GameState {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    seed: input.seed,
    realm: 0,
    qi: '0',
    demon: 0,
    workspace: input.workspace,
    programs: [],
    budgetPool: BASE_BUDGET,
    computeLimit: null,
    ownedBooks: [...(input.ownedBooks ?? [])],
    equippedBook: null,
    ownedArtifacts: [],
    equippedArtifacts: [],
    offlineRate: 0.6,
    stats: { totalQi: '0', breakthroughs: 0, playMs: 0 },
    lastSeenAt: input.now,
    speed: 1,
    chargeReadyAt: 0,
  };
}

export function newSave(input: { seed: number; workspace: unknown; now: number; ownedBooks?: readonly string[] | undefined }): SaveFile {
  return newEnvelope(input.now, newGameState(input));
}

// 读档装载前也要能算出「这份档的字节数」，所以序列化单独导出。
export function serializeSave(save: SaveFile): string {
  return formatSave(save);
}
