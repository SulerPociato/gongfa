import { readFileSync } from 'node:fs';
import { loadContent, Qi, TICK_MS, TICKS_PER_SEC, type ActionDef, type Content, type RealmDef } from '@gongfa/core';

const BREATH_ID = 'breath';
const ENTRY_REALM_ID = 0;
const TOTAL_TICKS = 600;
const TOTAL_SECONDS = (TOTAL_TICKS * TICK_MS) / 1000;
const EXPECTED_QI_AT_END = 600;
const TABLE_STEP_SECONDS = 10;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../content/${file}`, import.meta.url), 'utf8'));
}

function requireAction(content: Content, id: string): ActionDef {
  const action = content.actions.find((candidate) => candidate.id === id);
  if (action === undefined) throw new Error(`actions.json 缺少动作 ${id}`);
  return action;
}

function requireRealm(content: Content, id: number): RealmDef {
  const realm = content.realms.find((candidate) => candidate.id === id);
  if (realm === undefined) throw new Error(`realms.json 缺少境界 ${id}`);
  return realm;
}

// 契约 §2.2：第 k 次执行同一动作的边际递减
function marginalMult(k: number): number {
  return 1 / (1 + 0.25 * (k - 1));
}

// 契约 §2.1 + §2.3。cacheHitMult（玉简）、bookDecay、artifactMult 属任务 5/7，此处恒为 1。
function perTickGain(program: readonly ActionDef[], realm: RealmDef): Qi {
  let gain = Qi.zero;
  for (const [index, action] of program.entries()) {
    const perAction = Qi.mul(Qi.mul(action.baseGain, marginalMult(index + 1)), realm.actionMult);
    gain = Qi.add(gain, perAction);
  }
  return Qi.add(gain, Qi.div(realm.passivePerSec, TICKS_PER_SEC));
}

function markdownTable(qiAtSecond: readonly Qi[], displayRate: Qi): string {
  const rows = ['| 时间 | qi | 速率 |', '| --- | --- | --- |'];
  for (let second = 0; second <= TOTAL_SECONDS; second += TABLE_STEP_SECONDS) {
    const value = qiAtSecond[second];
    if (value === undefined) throw new Error(`缺少 ${second}s 的 qi 采样`);
    rows.push(`| ${second}s | ${Qi.format(value)} | ${Qi.format(displayRate)}/s |`);
  }
  return rows.join('\n');
}

const content = loadContent({ actions: readJson('actions.json'), realms: readJson('realms.json') });
const realm = requireRealm(content, ENTRY_REALM_ID);
const program: readonly ActionDef[] = [requireAction(content, BREATH_ID)];

const qiAtSecond: Qi[] = [Qi.zero];
let qi = Qi.zero;
for (let tick = 1; tick <= TOTAL_TICKS; tick++) {
  qi = Qi.add(qi, perTickGain(program, realm));
  if (tick % TICKS_PER_SEC === 0) qiAtSecond.push(qi);
}

const displayRate = Qi.mul(perTickGain(program, realm), TICKS_PER_SEC);
const matched = Qi.cmp(qi, EXPECTED_QI_AT_END) === 0;
const verdict = `qi(${TOTAL_SECONDS}s)=${Qi.format(qi)} expected=${Qi.format(EXPECTED_QI_AT_END)} rate=${Qi.format(displayRate)}/s ${matched ? 'OK' : 'MISMATCH'}`;

if (process.argv.includes('--table')) {
  console.log(markdownTable(qiAtSecond, displayRate));
  console.error(`# ${verdict}`);
} else {
  console.log(qiAtSecond.map((value, second) => `${second}s: ${Qi.format(value)}`).join('  '));
  console.log(`# ${verdict}`);
}

process.exitCode = matched ? 0 : 1;
