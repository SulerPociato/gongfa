// 平衡审计：用真实曲线预览算「每境达阈值需要多久」，与冻结目标对照
import { readFileSync } from 'node:fs';
import { loadContent, previewCurve, Qi, SPRINT_GOAL_QI, type Op } from '../packages/core/src/index';

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../content/${name}`, import.meta.url), 'utf8'));

const content = loadContent({ actions: readJson('actions.json') as never, realms: readJson('realms.json') as never });

const op = (o: Record<string, unknown>): Op => o as unknown as Op;
const ACTION = 'ACTION' as const;
const HALT = { op: 'HALT' } as Op;
const LOOP_BEGIN = (end: number, count: number): Op => op({ op: 'LOOP_BEGIN', end, count });
const LOOP_END: Op = op({ op: 'LOOP_END' });

const breath: Op = op({ op: ACTION, actionId: 'breath' });

/** 每境「一个刚进这境的玩家能写出的合理程序」。 */
const PROGRAM: Record<number, Op[]> = {
  0: [breath, breath, breath, HALT],
  1: [LOOP_BEGIN(3, 5), breath, LOOP_END, HALT],
  2: [LOOP_BEGIN(6, 10), breath, breath, breath, breath, LOOP_END, HALT],
  3: [LOOP_BEGIN(4, 3), LOOP_BEGIN(3, 5), breath, LOOP_END, LOOP_END, HALT],
};

// 冻结目标（契约 §3）：1:40 / 4:12 / 7:04 / 11:09
const TARGET_SEC = [100, 252, 424, 669];

for (const realm of content.realms) {
  const code = PROGRAM[realm.id];
  if (code === undefined) continue;
  const preview = previewCurve({ content, realmIndex: realm.id, code, budget: 200 });
  const perSec = preview.perSec;
  const threshold = Number(realm.threshold);
  const eta = perSec > 0 ? threshold / perSec : Infinity;
  const target = TARGET_SEC[realm.id] ?? 0;
  const delta = Math.round(((eta - target) / target) * 100);
  console.log(
    `${realm.name.zh} 阈值 ${threshold} · 速率 ${perSec.toFixed(1)}/s · 预计 ${Math.round(eta)}s ` +
    `(目标 ${target}s, ${delta >= 0 ? '+' : ''}${delta}%)`,
  );
}

// 附：试炼目标在当前速率下能否 60 秒达成（目标在核心表里，不在 realms.json）
for (const realm of content.realms) {
  const code = PROGRAM[realm.id];
  const goal = SPRINT_GOAL_QI[realm.id];
  if (code === undefined || goal === undefined) continue;
  const preview = previewCurve({ content, realmIndex: realm.id, code, budget: 200 });
  const sixty = preview.perSec * 60;
  console.log(`${realm.name.zh} 60 秒产出 ${Math.round(sixty)} / 试炼目标 ${Qi.format(goal)} → ${sixty >= Number(goal) ? '可达' : '不可达'}`);
}
