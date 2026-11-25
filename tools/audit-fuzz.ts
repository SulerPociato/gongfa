// 模糊测试：随机积木树 + 随机敌人输入，编译器/校验器/线性化都不许抛
import { readFileSync } from 'node:fs';
import { compileWorkspace } from '../packages/blocks/src/index';
import { linearizeProgram, loadContent, parseEnvelope, validateSave } from '../packages/core/src/index';

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../content/${name}`, import.meta.url), 'utf8'));

const content = loadContent({ actions: readJson('actions.json') as never, realms: readJson('realms.json') as never });

// 可复现随机
let seed = 0x9e3779b9;
const rnd = (): number => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
const int = (max: number): number => Math.floor(rnd() * max);

const ACTION_TYPES = ['breath', 'calm'] as const;
const STATEMENT_TYPES = ['gongfa_if', 'gongfa_repeat', 'gongfa_while', 'gongfa_batch'] as const;

function randomBlock(depth: number): Record<string, unknown> {
  const kind = rnd();
  if (depth <= 0 || kind < 0.5) {
    return { type: pick(ACTION_TYPES), id: `f${int(1e6)}` };
  }
  if (kind < 0.6) {
    return { type: 'gongfa_compare', id: `f${int(1e6)}`, fields: { LEFT: pick(['demon', 'budget', 'qi', 'nonsense']), OP: pick(['>', '<', '>=', '<=', '==', '@@']), THRESHOLD: pick([0, 0.5, -1, 1e9, 'abc', null]) } };
  }
  if (kind < 0.7) {
    return { type: pick(['gongfa_break', 'gongfa_continue', 'gongfa_hat_orphan']), id: `f${int(1e6)}` };
  }
  const type = pick(STATEMENT_TYPES);
  const block: Record<string, unknown> = { type, id: `f${int(1e6)}` };
  if (type === 'gongfa_repeat') block.fields = { NUM: pick([1, 3, 0, -5, 1e6, 2.5, 'x']) };
  if (type === 'gongfa_while') block.inputs = { CONDITION: { block: { type: 'gongfa_compare', id: `c${int(1e6)}`, fields: { LEFT: 'budget', OP: '>', THRESHOLD: int(200) } } }, DO: { block: randomBlock(depth - 1) } };
  else if (type === 'gongfa_if') block.inputs = { CONDITION: { block: { type: 'gongfa_compare', id: `c${int(1e6)}`, fields: { LEFT: 'demon', OP: '>', THRESHOLD: 0.5 } } }, IF: { block: randomBlock(depth - 1) }, ELSE: { block: randomBlock(depth - 1) } };
  else block.inputs = { DO: { block: randomBlock(depth - 1) } };
  return block;
}

function randomWorkspace(): unknown {
  const body = randomBlock(int(4));
  return { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h', x: int(100), y: int(100), inputs: { BODY: { block: body } } }] } };
}

let throws = 0;
let compiled = 0;
let overBudget = 0;
const started = Date.now();
const N = 1500;

for (let i = 0; i < N; i += 1) {
  const workspace = randomWorkspace();
  try {
    const result = compileWorkspace(workspace as never);
    if (result.ok && result.program !== null) {
      compiled += 1;
      const linear = linearizeProgram(result.program.code, 200);
      if (linear.steps > 200) overBudget += 1;
    }
  } catch (error) {
    throws += 1;
    if (throws <= 3) console.log('COMPILER THROW', (error as Error).message, JSON.stringify(workspace).slice(0, 160));
  }
}

// 保存校验的模糊输入
const hostile = [null, undefined, 0, '', 'x', [], {}, { schemaVersion: 1 }, { schemaVersion: 999, state: {} }, { schemaVersion: 1, state: { qi: 'NaN' } }];
for (const value of hostile) {
  try { validateSave(value); } catch { throws += 1; console.log('VALIDATOR THROW', JSON.stringify(value)); }
}
const texts = ['', '{', '[]', 'null', '{"schemaVersion":1}', '{"schemaVersion":1,"state":null}', '\u0000'];
for (const text of texts) {
  try { parseEnvelope(text); } catch (error) { throws += 1; console.log('ENVELOPE THROW', (error as Error).message); }
}

console.log(`fuzz: ${N} 个随机功法 · 编译成功 ${compiled} · 超预算 ${overBudget} · 抛异常 ${throws} · ${Date.now() - started}ms`);
console.log(`content: ${content.realms.length} 境 / ${content.actions.length} 动作`);
