import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/loader';
import type { Content } from '../content/schema';
import { verifyProgram, type VerifyCheck, type VerifyIssue, type VerifyResult } from './verifier';
import { MAX_LOOP_DEPTH, MAX_STATIC_INSTRUCTIONS, MAX_VALUE_STACK_DEPTH, type Op, type Program } from './program';

const CONTENT: Content = loadContent({
  actions: [{ id: 'breath', baseGain: 1, demonDelta: 0, kind: 'gain' }],
  realms: [{ id: 0, name: { zh: '炼气' }, threshold: '1e3', passivePerSec: 0, actionMult: 1 }],
});

function program(code: readonly Op[]): Program {
  return { id: 'p0', code };
}

function verify(code: unknown[]): VerifyResult {
  return verifyProgram(program(code as Op[]), CONTENT);
}

function firstIssue(code: unknown[], check: VerifyCheck): VerifyIssue {
  const result = verify(code);
  const issue = result.errors.find((candidate) => candidate.check === check);
  expect(result.ok, `期望 ${check} 报错，实际 errors=${JSON.stringify(result.errors)}`).toBe(false);
  expect(issue, `errors 里没有 ${check}：${JSON.stringify(result.errors)}`).toBeDefined();
  return issue as VerifyIssue;
}

const HALT: Op = { op: 'HALT' };
const BREATH: Op = { op: 'ACTION', actionId: 'breath' };

describe('verifier 通过路径', () => {
  it('筑基参考程序（循环 3 次吐纳）零错误', () => {
    const result = verify([
      { op: 'LOOP_BEGIN', end: 2, count: 3 },
      BREATH,
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ]);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('如果/否则形状（CMP + JMP_IF_FALSE + JMP）零错误', () => {
    const result = verify([
      { op: 'LOAD', key: 'demon' },
      { op: 'PUSH', value: 0.5 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 8 },
      { op: 'LOOP_BEGIN', end: 6, count: 2 },
      BREATH,
      { op: 'LOOP_END', begin: 4 },
      { op: 'JMP', target: 11 },
      { op: 'LOOP_BEGIN', end: 10, count: 3 },
      BREATH,
      { op: 'LOOP_END', begin: 8 },
      HALT,
    ]);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });
});

describe('verifier 拒绝路径', () => {
  it('jump-target：目标越界', () => {
    const issue = firstIssue([{ op: 'JMP', target: 9 }, HALT], 'jump-target');
    expect(issue.pc).toBe(0);
    expect(issue.message).toContain('越界');
  });

  it('loop-pair：end 指向的不是 LOOP_END', () => {
    const issue = firstIssue([{ op: 'LOOP_BEGIN', end: 2, count: 2 }, BREATH, HALT], 'loop-pair');
    expect(issue.message).toContain('处不是 LOOP_END');
  });

  it('loop-pair：孤立的 LOOP_END', () => {
    const issue = firstIssue([BREATH, { op: 'LOOP_END', begin: 0 }], 'loop-pair');
    expect(issue.message).toContain('没有被任何 LOOP_BEGIN 认领');
  });

  it('loop-pair：区间交叉嵌套', () => {
    const issue = firstIssue(
      [
        { op: 'LOOP_BEGIN', end: 3, count: 2 },
        HALT,
        { op: 'LOOP_BEGIN', end: 5, count: 2 },
        { op: 'LOOP_END', begin: 0 },
        HALT,
        { op: 'LOOP_END', begin: 2 },
      ],
      'loop-pair',
    );
    expect(issue.message).toContain('交叉嵌套');
  });

  it('stack-depth：操作数不足', () => {
    const issue = firstIssue([{ op: 'ADD' }, HALT], 'stack-depth');
    expect(issue.message).toContain('需要 2 个操作数');
  });

  it('stack-depth：取值栈超过 16', () => {
    const pushes = Array.from({ length: MAX_VALUE_STACK_DEPTH + 1 }, () => ({ op: 'PUSH', value: 1 }));
    const issue = firstIssue(pushes, 'stack-depth');
    expect(issue.message).toContain('取值栈深');
  });

  it('stack-depth：循环帧超过 16 层', () => {
    const depth = MAX_LOOP_DEPTH + 1;
    const code: unknown[] = [];
    for (let i = 0; i < depth; i++) code.push({ op: 'LOOP_BEGIN', end: 2 * depth - i, count: 2 });
    code.push(BREATH);
    for (let j = 0; j < depth; j++) code.push({ op: 'LOOP_END', begin: depth - 1 - j });
    code.push(HALT);
    const issue = firstIssue(code, 'stack-depth');
    expect(issue.message).toContain('循环帧');
  });

  it('type：未知指令 / PUSH 非有限 / LOAD 未知 key', () => {
    expect(firstIssue([{ op: 'CALL' }], 'type').message).toContain('未知指令');
    expect(firstIssue([{ op: 'PUSH', value: Number.NaN }], 'type').message).toContain('PUSH.value');
    expect(firstIssue([{ op: 'LOAD', key: 'hp' }], 'type').message).toContain('LOAD.key');
    expect(firstIssue([null], 'type').message).toContain('指令不是对象');
  });

  it('entry：空指令流与跳回 0', () => {
    expect(firstIssue([], 'entry').message).toContain('入口块缺失');
    const back = firstIssue([HALT, { op: 'JMP', target: 0 }], 'entry');
    expect(back.pc).toBe(1);
    expect(back.message).toContain('单入口');
  });

  it('instruction-count：静态指令数超过 500', () => {
    const code = Array.from({ length: MAX_STATIC_INSTRUCTIONS + 1 }, () => HALT);
    const issue = firstIssue(code, 'instruction-count');
    expect(issue.message).toContain('超过上限 500');
  });

  it('action-id：不在 actions.json 中', () => {
    const issue = firstIssue([{ op: 'ACTION', actionId: 'herb' }, HALT], 'action-id');
    expect(issue.message).toContain('herb');
  });

  it('div-zero：常量 0 与折叠后为 0', () => {
    expect(firstIssue([{ op: 'PUSH', value: 10 }, { op: 'PUSH', value: 0 }, { op: 'DIV' }], 'div-zero').pc).toBe(2);
    const folded = firstIssue(
      [{ op: 'PUSH', value: 8 }, { op: 'PUSH', value: 3 }, { op: 'PUSH', value: 3 }, { op: 'SUB' }, { op: 'DIV' }],
      'div-zero',
    );
    expect(folded.pc).toBe(4);
  });

  it('loop-count：count 必须在 1..10', () => {
    const zero = [
      { op: 'LOOP_BEGIN', end: 2, count: 0 },
      BREATH,
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ];
    expect(firstIssue(zero, 'loop-count').message).toContain('count=0');
    const tooMany = [
      { op: 'LOOP_BEGIN', end: 2, count: 11 },
      BREATH,
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ];
    expect(firstIssue(tooMany, 'loop-count').message).toContain('count=11');
  });

  it('loop-count：count=0 按 §4.2 跳过整个循环体，体栈下溢不重复报', () => {
    const result = verify([
      { op: 'LOOP_BEGIN', end: 2, count: 0 },
      { op: 'ADD' },
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ]);
    expect(result.errors.map((issue) => issue.check)).toEqual(['loop-count']);
    expect(result.warnings.join(' ')).toContain('静态不可达');
  });

  it('一次校验汇总多条错误', () => {
    const result = verify([
      { op: 'ACTION', actionId: 'herb' },
      { op: 'JMP', target: 42 },
      { op: 'LOOP_END', begin: 9 },
    ]);
    expect(result.errors.length).toBeGreaterThan(2);
  });

  it('静态不可达只给警告，不阻塞', () => {
    const result = verify([HALT, { op: 'PUSH', value: 1 }]);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('静态不可达');
  });
});
