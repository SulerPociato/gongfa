import { describe, expect, it } from 'vitest';
import { BASE_BUDGET, PREVIEW_TICKS, Qi, Vm, demonlessSink, linearizeProgram, loadContent, makeActionSink, passivePerTick, previewCurve, type Program } from '@gongfa/core';
import actionsJson from '../../../content/actions.json';
import realmsJson from '../../../content/realms.json';
import { compileWorkspace, type SerializedBlock, type WorkspaceJson } from './compiler';

// 任务 8 P0-B：曲线预览走的是真编译器产物，不是手抄 IR —— 手抄那份只能证明 core 自洽，
// 这一份证明「玩家拖的积木」和「面板画的曲线」之间没有第三种口径。
const CONTENT = loadContent({ actions: actionsJson, realms: realmsJson });

// Blockly 的语句序列：首块挂在 BODY，后续兄弟挂在 next.block。
function chain(blocks: readonly SerializedBlock[]): SerializedBlock | undefined {
  const [first, ...rest] = blocks as [SerializedBlock | undefined, ...SerializedBlock[]];
  if (first === undefined) return undefined;
  const next = chain(rest);
  return next === undefined ? first : { ...first, next: { block: next } };
}

function hat(...blocks: SerializedBlock[]): WorkspaceJson {
  const body = chain(blocks);
  if (body === undefined) throw new Error('「每 tick」凹槽是空的，这份夹具没有意义');
  return { blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', id: 'h', x: 32, y: 32, inputs: { BODY: { block: body } } }] } };
}

const breath: SerializedBlock = { type: 'breath', id: 'b1' };
const breath2: SerializedBlock = { type: 'breath', id: 'b2' };
const breath3: SerializedBlock = { type: 'breath', id: 'b3' };
const calm: SerializedBlock = { type: 'calm', id: 'c1' };

function compiled(workspace: WorkspaceJson): Program {
  const result = compileWorkspace(workspace);
  if (result.program === null) throw new Error(`编译失败：${result.errors.join(' ｜ ')}`);
  return result.program;
}

function previewOf(workspace: WorkspaceJson, realmIndex = 0) {
  return previewCurve({ content: CONTENT, realmIndex, code: compiled(workspace).code });
}

// 真 VM 参照：心魔钉 0（杂念乘数恒 1）、无玉简、无书 —— 与模型唯一的差项被逐项关掉之后，累计必须逐位相等。
function vmLedger(program: Program, realmIndex: number, seedDemon: number): Qi {
  const realm = CONTENT.realms[realmIndex]!;
  const sink = demonlessSink(() => makeActionSink({ content: CONTENT, realmIndex }));
  const state = { qi: 0, demon: seedDemon };
  const vm = new Vm({
    content: CONTENT,
    sink,
    vars: () => ({ qi: state.qi, rate: 0, demon: state.demon, realm: realm.id, budget: BASE_BUDGET }),
  });
  vm.installUnchecked([program]);
  let total = Qi.zero;
  for (let tick = 0; tick < PREVIEW_TICKS; tick += 1) {
    const result = vm.tick();
    total = Qi.add(total, Qi.add(result.gain, passivePerTick(realm)));
    state.qi = total;
  }
  return total;
}

const REFERENCE: WorkspaceJson = hat({
  type: 'gongfa_if',
  id: 'i1',
  inputs: {
    CONDITION: { block: { type: 'gongfa_compare', id: 'cmp1', fields: { LEFT: 'demon', OP: '>', THRESHOLD: 0.5 } } },
    IF: { block: calm },
    ELSE: { block: { type: 'gongfa_repeat', id: 'r1', fields: { NUM: 3 }, inputs: { DO: { block: breath } } } },
  },
});

describe('真积木 → 曲线：验收 4 的两个读数', () => {
  it('炼气拖 1 块吐纳：10/秒，预计 100 秒达标', () => {
    const preview = previewOf(hat(breath));
    expect(preview.perSec).toBe(10);
    expect(preview.etaSec).toBe(100);
    expect(preview.threshold).toBe(1e3);
    expect(preview.points.length).toBe(60);
    expect(preview.points[59]).toBe(600);
  });

  it('再拖第 2 块：曲线抬升到 18/秒，预计 56 秒达标', () => {
    const one = previewOf(hat(breath));
    const two = previewOf(hat(breath, breath2));
    expect(two.perSec).toBeCloseTo(18, 12);
    expect(two.etaSec).toBe(56);
    expect(two.points[59]).toBeGreaterThan(one.points[59]!);
    expect(two.perSec / one.perSec - 1).toBeCloseTo(0.8, 12);
  });

  it('第 3 块还在涨，但边际递减让涨幅收窄：24.7/秒、预计 41 秒', () => {
    const three = previewOf(hat(breath, breath2, breath3));
    expect(three.perSec).toBeCloseTo(24.666666, 4);
    expect(three.etaSec).toBe(41);
  });
});

describe('预览 ↔ 真 VM（编译器产物）', () => {
  it('参考策略（心魔 0.3 ≤ 0.5，走否则支）：曲线末点与 600 tick 累计逐位相等', () => {
    const program = compiled(REFERENCE);
    const preview = previewCurve({ content: CONTENT, realmIndex: 0, code: program.code });
    expect(preview.points[59]).toBe(vmLedger(program, 0, 0.3));
    expect(preview.perTick).toBeCloseTo(1 + 0.8 + 1 / 1.5, 15);
  });

  it('线性化后是三支吐纳，调息那支被「不成立」跳过', () => {
    expect(linearizeProgram(compiled(REFERENCE).code).actionIds).toEqual(['breath', 'breath', 'breath']);
  });

  it('心魔真超线时两边会分叉：曲线按否则支估，实际这一 tick 只调息（面板那句免责声明的依据）', () => {
    const program = compiled(REFERENCE);
    expect(previewCurve({ content: CONTENT, realmIndex: 0, code: program.code }).perTick).toBeGreaterThan(0);
    expect(vmLedger(program, 0, 0.9)).toBe(Qi.zero);
  });

  it('筑基起「循环」可用：循环 5 次的曲线与真 VM 同数', () => {
    const program = compiled(hat({ type: 'gongfa_repeat', id: 'r', fields: { NUM: 5 }, inputs: { DO: { block: breath } } }));
    const preview = previewCurve({ content: CONTENT, realmIndex: 1, code: program.code });
    expect(preview.points[59]).toBe(vmLedger(program, 1, 0));
    expect(preview.perTick).toBeCloseTo((1 + 0.8 + 1 / 1.5 + 1 / 1.75 + 1 / 2) * 3 + 0.5, 15);
  });
});
