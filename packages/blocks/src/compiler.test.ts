import { describe, expect, it } from 'vitest';
import type { Op } from '@gongfa/core/vm';
import { compileWorkspace, type SerializedBlock, type WorkspaceJson } from './compiler';
import { BLOCK_DEFINITIONS, BLOCK_SPECS, BREATH_JSON, STARTER_WORKSPACE_JSON, TICK_HAT_JSON, TOOLBOX_JSON } from './definitions';

function breath(id = 'b1'): SerializedBlock {
  return { type: 'breath', id };
}

// 2 块链：Blockly 把语句输入的第一个块放进 inputs.BODY.block，后续兄弟挂在 next.block
function stack(...ids: string[]): SerializedBlock {
  let block: SerializedBlock = { type: 'breath', id: ids[ids.length - 1] ?? 'b' };
  for (let i = ids.length - 2; i >= 0; i--) {
    block = { type: 'breath', id: ids[i] ?? 'b', next: { block } };
  }
  return block;
}

function workspace(blocks: readonly SerializedBlock[]): WorkspaceJson {
  return { blocks: { languageVersion: 0, blocks } };
}

function hat(body?: SerializedBlock): WorkspaceJson {
  return workspace(body === undefined ? [{ type: 'tick_hat', id: 'h', x: 32, y: 32 }] : [{ type: 'tick_hat', id: 'h', x: 32, y: 32, inputs: { BODY: { block: body } } }]);
}

// 任务 4 的三块：字段值一律走 fields（Blockly 把 field_number 存成 number、field_dropdown 存成 string，两种都要吃）
function compare(left: string, op: string, threshold: number | string, id = 'c1'): SerializedBlock {
  return { type: 'gongfa_compare', id, fields: { LEFT: left, OP: op, THRESHOLD: threshold } };
}

function repeat(count: number | string, body?: SerializedBlock, id = 'r1'): SerializedBlock {
  return body === undefined
    ? { type: 'gongfa_repeat', id, fields: { NUM: count } }
    : { type: 'gongfa_repeat', id, fields: { NUM: count }, inputs: { DO: { block: body } } };
}

function ifElse(cond?: SerializedBlock, then?: SerializedBlock, otherwise?: SerializedBlock, id = 'i1'): SerializedBlock {
  const inputs: NonNullable<SerializedBlock['inputs']> = {};
  if (cond !== undefined) inputs['CONDITION'] = { block: cond };
  if (then !== undefined) inputs['IF'] = { block: then };
  if (otherwise !== undefined) inputs['ELSE'] = { block: otherwise };
  return { type: 'gongfa_if', id, inputs };
}

const ACTION_BREATH: Op = { op: 'ACTION', actionId: 'breath' };
const ACTION_CALM: Op = { op: 'ACTION', actionId: 'calm' };
const HALT: Op = { op: 'HALT' };

// 验收 1 的目标程序：每 tick → 如果 心魔 > 0.5 则 调息 否则 循环 3 次 吐纳
const ACCEPTANCE_PROGRAM: WorkspaceJson = hat(
  ifElse(compare('demon', '>', '0.5'), { type: 'calm', id: 's1' }, repeat('3', breath('s2'))),
);

// 逐字段照抄无头 Blockly 13.4.0 `serialization.workspaces.save()` 的真实输出（含随机 id）
const CAPTURED: WorkspaceJson = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'tick_hat',
        id: 'o:^(s,l3Z(ZfTyVO[Oo,',
        x: 0,
        y: 0,
        inputs: {
          BODY: {
            block: {
              type: 'breath',
              id: ')H:$,(c(H%p/GN~2+AnO',
              next: { block: { type: 'breath', id: ',rdkGJ{K7tdtSAbY9L-b' } },
            },
          },
        },
      },
    ],
  },
};

// 浏览器里把「吐纳」拖进凹槽后，serialization.workspaces.save() 的真实输出（原样照抄，含 id 与坐标）
const CAPTURED_FROM_BROWSER: WorkspaceJson = {
  blocks: {
    blocks: [
      {
        id: '3]8%;U%^D=Ue47wv4l6K',
        inputs: {
          BODY: {
            block: {
              id: '0QS{Z4C|p1$5osiMz:gC',
              type: 'breath',
            },
          },
        },
        type: 'tick_hat',
        x: 32,
        y: 32,
      },
    ],
    languageVersion: 0,
  },
};

// 验收 1：浏览器里 5 次真实拖拽搭出「每 tick → 如果 心魔 > 0.5 则 调息 否则 循环 3 次 吐纳」后的 save() 原样输出
// （2026-11-19 改名 gongfa_* 之后重采，id 与坐标就是当次拖拽的结果）。
// 与 ACCEPTANCE_PROGRAM 的区别只有 id / 坐标，以及字段是 Blockly 的原生类型（THRESHOLD、NUM 是 number 不是 string）。
const CAPTURED_ACCEPTANCE_FROM_BROWSER: WorkspaceJson = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'tick_hat',
        id: 'SMW.0nX.C0oVT,8**^NK',
        x: 32,
        y: 32,
        inputs: {
          BODY: {
            block: {
              type: 'gongfa_if',
              id: '{[@!8f|}K7=^V#6N)9_:',
              inputs: {
                CONDITION: {
                  block: {
                    type: 'gongfa_compare',
                    id: ',qa|7A4tJ:v+TY,J(m1i',
                    fields: { LEFT: 'demon', OP: '>', THRESHOLD: 0.5 },
                  },
                },
                IF: { block: { type: 'calm', id: 'Ca/7}W$Cp`[uj$!{qro@' } },
                ELSE: {
                  block: {
                    type: 'gongfa_repeat',
                    id: 'OG](:%{d=|)fTL2ZSfk_',
                    fields: { NUM: 3 },
                    inputs: { DO: { block: { type: 'breath', id: '(1quRLZF^en#9QS8@=;R' } } },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
};

// 验收 3 的 stall 程序：3 层「循环 10 次」套「吐纳」，浏览器 save() 原样输出（HUD 报「第 200 步没跑完」）
const CAPTURED_DEEP_LOOP_FROM_BROWSER: WorkspaceJson = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'tick_hat',
        id: 'QurNV7;AY5B{^1d3=pv2',
        x: 0,
        y: 32,
        inputs: {
          BODY: {
            block: {
              type: 'gongfa_repeat',
              id: '|HGLf+-Q%[vrg$TXo,o?',
              fields: { NUM: 10 },
              inputs: {
                DO: {
                  block: {
                    type: 'gongfa_repeat',
                    id: '3okY?cjJ0ApEU9e%@UG#',
                    fields: { NUM: 10 },
                    inputs: {
                      DO: {
                        block: {
                          type: 'gongfa_repeat',
                          id: '`~Eh!xtABjBDD.Ygx@XH',
                          fields: { NUM: 10 },
                          inputs: { DO: { block: { type: 'breath', id: 'ES`E^%)RwX6;~hnnHY/c' } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
};

describe('compileWorkspace（Blockly JSON → IR）', () => {
  it('入口 + 1 个吐纳 → ACTION + HALT', () => {
    const result = compileWorkspace(hat(breath()));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.program).toEqual({ id: 'gongfa', code: [{ op: 'ACTION', actionId: 'breath' }, { op: 'HALT' }] });
  });

  it('真实 save() 输出的 2 块链编译成 2 个 ACTION', () => {
    const result = compileWorkspace(CAPTURED);
    expect(result.ok).toBe(true);
    expect(result.program?.code).toEqual([
      { op: 'ACTION', actionId: 'breath' },
      { op: 'ACTION', actionId: 'breath' },
      { op: 'HALT' },
    ]);
  });

  it('浏览器真实拖拽产物（子块只挂在 inputs.BODY.block）编译成 1 个 ACTION', () => {
    const result = compileWorkspace(CAPTURED_FROM_BROWSER);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.program?.code).toEqual([{ op: 'ACTION', actionId: 'breath' }, { op: 'HALT' }]);
  });

  it('只预置入口、BODY 空 → 只剩 HALT，装载合法且本 tick 不产出', () => {
    const result = compileWorkspace(hat());
    expect(result.ok).toBe(true);
    expect(result.program?.code).toEqual([{ op: 'HALT' }]);
  });

  it('链上 3 块按顺序展开', () => {
    const result = compileWorkspace(hat(stack('b1', 'b2', 'b3')));
    expect(result.program?.code.length).toBe(4);
    expect(result.program?.code.filter((op) => op.op === 'ACTION').length).toBe(3);
  });

  it('没有入口块 → 报错且不产出程序', () => {
    const result = compileWorkspace(workspace([breath()]));
    expect(result.ok).toBe(false);
    expect(result.program).toBeNull();
    expect(result.errors.join(' ')).toContain('缺少「每 tick」入口块');
    expect(result.warnings.join(' ')).toContain('孤立方块');
  });

  it('两个入口块 → 契约 §4.4 只允许一个', () => {
    const result = compileWorkspace(workspace([{ type: 'tick_hat', id: 'h1' }, { type: 'tick_hat', id: 'h2' }]));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('入口块有 2 个');
  });

  it('未知积木在顶层与在链上都报错', () => {
    expect(compileWorkspace(workspace([{ type: 'artifact_loop', id: 'x' }])).errors.join(' ')).toContain('未知积木「artifact_loop」');
    const nested = compileWorkspace(hat({ type: 'breath', id: 'b1', next: { block: { type: 'herb', id: 'b2' } } }));
    expect(nested.ok).toBe(false);
    expect(nested.errors.join(' ')).toContain('未知积木「herb」');
  });

  it('空工作区 / 缺字段不抛异常', () => {
    expect(compileWorkspace({}).ok).toBe(false);
    expect(compileWorkspace({ blocks: {} }).errors.length).toBe(1);
  });
});

describe('条件与循环编译（任务 4）', () => {
  it('验收 1 程序 → 逐条 IR 相等（含回补后的跳转目标）', () => {
    const result = compileWorkspace(ACCEPTANCE_PROGRAM);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.program?.code).toEqual([
      { op: 'LOAD', key: 'demon' },
      { op: 'PUSH', value: 0.5 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 6 },
      ACTION_CALM,
      { op: 'JMP', target: 9 },
      { op: 'LOOP_BEGIN', end: 8, count: 3 },
      ACTION_BREATH,
      { op: 'LOOP_END', begin: 6 },
      HALT,
    ]);
  });

  it('浏览器真实拖拽产物（验收 1）与 ACCEPTANCE_PROGRAM 编译结果逐条相等', () => {
    const fromBrowser = compileWorkspace(CAPTURED_ACCEPTANCE_FROM_BROWSER);
    const handWritten = compileWorkspace(ACCEPTANCE_PROGRAM);
    expect(fromBrowser.errors).toEqual([]);
    expect(fromBrowser.warnings).toEqual([]);
    expect(fromBrowser.ok).toBe(true);
    expect(fromBrowser.program).toEqual(handWritten.program);
    expect(fromBrowser.program?.code.length).toBe(10);
  });

  it('浏览器真实拖拽产物（3 层循环）→ 三层回边互指，最内层包住唯一 ACTION', () => {
    const result = compileWorkspace(CAPTURED_DEEP_LOOP_FROM_BROWSER);
    expect(result.errors).toEqual([]);
    expect(result.program?.code).toEqual([
      { op: 'LOOP_BEGIN', end: 6, count: 10 },
      { op: 'LOOP_BEGIN', end: 5, count: 10 },
      { op: 'LOOP_BEGIN', end: 4, count: 10 },
      ACTION_BREATH,
      { op: 'LOOP_END', begin: 2 },
      { op: 'LOOP_END', begin: 1 },
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ]);
  });

  it('没有「否则」分支 → JMP_IF_FALSE 直接落到分支之后', () => {
    const result = compileWorkspace(hat(ifElse(compare('qi', '>', 1000), breath())));
    expect(result.program?.code).toEqual([
      { op: 'LOAD', key: 'qi' },
      { op: 'PUSH', value: 1000 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 5 },
      ACTION_BREATH,
      HALT,
    ]);
  });

  it('循环 3 次 吐纳 → LOOP_BEGIN / LOOP_END 互指', () => {
    const result = compileWorkspace(hat(repeat(3, breath())));
    expect(result.program?.code).toEqual([
      { op: 'LOOP_BEGIN', end: 2, count: 3 },
      ACTION_BREATH,
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ]);
  });

  it('循环套如果套循环（三层混合）→ 每层回边各自闭合', () => {
    const result = compileWorkspace(hat(repeat(2, ifElse(compare('budget', '<', 50), repeat(3, breath())))));
    expect(result.errors).toEqual([]);
    expect(result.program?.code).toEqual([
      { op: 'LOOP_BEGIN', end: 8, count: 2 },
      { op: 'LOAD', key: 'budget' },
      { op: 'PUSH', value: 50 },
      { op: 'CMP', arg: '<' },
      { op: 'JMP_IF_FALSE', target: 8 },
      { op: 'LOOP_BEGIN', end: 7, count: 3 },
      ACTION_BREATH,
      { op: 'LOOP_END', begin: 5 },
      { op: 'LOOP_END', begin: 0 },
      HALT,
    ]);
  });

  it('入口链上「调息 → 如果…」按顺序展开，跳转目标跟着位移', () => {
    const result = compileWorkspace(hat({ type: 'calm', id: 's1', next: { block: ifElse(compare('demon', '<', '0.5'), breath()) } }));
    expect(result.program?.code).toEqual([
      ACTION_CALM,
      { op: 'LOAD', key: 'demon' },
      { op: 'PUSH', value: 0.5 },
      { op: 'CMP', arg: '<' },
      { op: 'JMP_IF_FALSE', target: 6 },
      ACTION_BREATH,
      HALT,
    ]);
  });

  it('条件缺失 → 报错，不静默当假', () => {
    const result = compileWorkspace(hat(ifElse(undefined, breath())));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('「如果」缺少条件');
  });

  it('循环体为空 → 报错', () => {
    const result = compileWorkspace(hat(repeat(3)));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('「循环」的循环体为空');
  });

  it('循环次数越界（0 / 11 / 非数字 / 缺字段）→ 报错并带上收到的值', () => {
    for (const bad of ['0', '11', 'abc']) {
      const result = compileWorkspace(hat(repeat(bad, breath())));
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain(`「循环」次数必须是 1–10，收到 ${bad}`);
    }
    const missing = compileWorkspace(hat({ type: 'gongfa_repeat', id: 'r', inputs: { DO: { block: breath() } } }));
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(' ')).toContain('「循环」次数必须是 1–10');
  });

  it('比较左值不在 qi / demon / budget 之内 → 报错', () => {
    const result = compileWorkspace(hat(ifElse(compare('hp', '>', 1), breath())));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('「比较」的左值「hp」不在允许清单');
  });

  it('阈值不是有限数 → 报错', () => {
    const result = compileWorkspace(hat(ifElse(compare('demon', '>', 'x'), breath())));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('「比较」的阈值不是数字');
  });

  it('比较积木被放进语句序列 → 报错（它只能当条件）', () => {
    const result = compileWorkspace(hat(compare('demon', '>', 0.5)));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('「比较」只能接在「如果」的条件位');
  });

  it('「则」分支为空 → 警告而不是错误', () => {
    const result = compileWorkspace(hat(ifElse(compare('demon', '>', 0.5))));
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('「如果」的「则」分支为空');
    expect(result.program?.code).toEqual([
      { op: 'LOAD', key: 'demon' },
      { op: 'PUSH', value: 0.5 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 4 },
      HALT,
    ]);
  });

  it('分支里的未知积木照样报错（不静默跳过）', () => {
    const result = compileWorkspace(hat(ifElse(compare('demon', '>', 0.5), { type: 'herb', id: 'x' })));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('未知积木「herb」');
  });
});

describe('积木定义与内容表对齐', () => {
  it('P0 九块：入口 + 吐纳/调息 + 如果/循环/比较 + 中断/继续/重复直到，工具箱含除入口外的全部', () => {
    expect(BLOCK_DEFINITIONS.length).toBe(9);
    expect(Object.keys(BLOCK_SPECS).sort()).toEqual([
      'breath', 'calm', 'gongfa_break', 'gongfa_compare', 'gongfa_continue', 'gongfa_if',
      'gongfa_repeat', 'gongfa_while', 'tick_hat',
    ]);
    expect(BLOCK_SPECS['breath']?.actionId).toBe('breath');
    expect(BLOCK_SPECS['calm']?.actionId).toBe('calm');
    expect(BLOCK_SPECS['gongfa_break']?.kind).toBe('control');
    expect(BLOCK_SPECS['gongfa_continue']?.kind).toBe('control');
    expect(BLOCK_SPECS['gongfa_while']?.kind).toBe('control');
    expect(TICK_HAT_JSON.message0).toBe('每 tick %1');
    expect(BREATH_JSON.message0).toBe('吐纳');
    expect(TOOLBOX_JSON.contents).toEqual([
      { kind: 'block', type: 'breath' },
      { kind: 'block', type: 'calm' },
      { kind: 'block', type: 'gongfa_if' },
      { kind: 'block', type: 'gongfa_repeat' },
      { kind: 'block', type: 'gongfa_compare' },
      { kind: 'block', type: 'gongfa_break' },
      { kind: 'block', type: 'gongfa_continue' },
      { kind: 'block', type: 'gongfa_while' },
    ]);
    expect(STARTER_WORKSPACE_JSON.blocks.blocks.length).toBe(1);
  });
});

// 批次 5：break / continue / while 编译测试
describe('中断/继续/重复直到编译', () => {
  function breakBlock(): SerializedBlock {
    return { type: 'gongfa_break', id: 'brk1' };
  }
  function continueBlock(): SerializedBlock {
    return { type: 'gongfa_continue', id: 'cont1' };
  }
  function repeatBlock(count: number, body: SerializedBlock): SerializedBlock {
    return {
      type: 'gongfa_repeat',
      id: 'rep1',
      fields: { NUM: count },
      inputs: { DO: { block: body } },
    };
  }
  function whileBlock(cond: SerializedBlock, body: SerializedBlock): SerializedBlock {
    return {
      type: 'gongfa_while',
      id: 'whl1',
      inputs: { CONDITION: { block: cond }, DO: { block: body } },
    };
  }
  function compareBlock(left: string, op: string, threshold: number): SerializedBlock {
    return {
      type: 'gongfa_compare',
      id: 'cmp1',
      fields: { LEFT: left, OP: op, THRESHOLD: threshold },
    };
  }
  function hatWith(body: SerializedBlock): WorkspaceJson {
    return {
      blocks: {
        languageVersion: 0,
        blocks: [{ type: 'tick_hat', id: 'hat', inputs: { BODY: { block: body } } }],
      },
    };
  }

  it('repeat 内 break → BREAK op', () => {
    const result = compileWorkspace(hatWith(repeatBlock(3, breakBlock())));
    expect(result.ok).toBe(true);
    const code = result.program!.code;
    // LOOP_BEGIN, BREAK, LOOP_END, HALT
    expect(code).toEqual([
      { op: 'LOOP_BEGIN', end: 2, count: 3 },
      { op: 'BREAK' },
      { op: 'LOOP_END', begin: 0 },
      { op: 'HALT' },
    ]);
  });

  it('repeat 内 continue → JMP{LOOP_END pc}', () => {
    const result = compileWorkspace(hatWith(repeatBlock(3, continueBlock())));
    expect(result.ok).toBe(true);
    const code = result.program!.code;
    // LOOP_BEGIN@0, JMP{target:2}@1, LOOP_END@2, HALT@3
    expect(code).toEqual([
      { op: 'LOOP_BEGIN', end: 2, count: 3 },
      { op: 'JMP', target: 2 },
      { op: 'LOOP_END', begin: 0 },
      { op: 'HALT' },
    ]);
  });

  it('while 基础编译：条件 + 体 + WHILE_END + WHILE_EXIT', () => {
    const body = breath();
    const cond = compareBlock('demon', '>', 0.5);
    const result = compileWorkspace(hatWith(whileBlock(cond, body)));
    expect(result.ok).toBe(true);
    const code = result.program!.code;
    // WHILE_BEGIN@0, LOAD@1, PUSH@2, CMP@3, JMP_IF_FALSE@4→8, ACTION@5, WHILE_END@6{begin:0}, WHILE_EXIT@7, HALT@8
    expect(code.length).toBe(9);
    expect(code[0]).toEqual({ op: 'WHILE_BEGIN' });
    expect(code[1]).toEqual({ op: 'LOAD', key: 'demon' });
    expect(code[2]).toEqual({ op: 'PUSH', value: 0.5 });
    expect(code[3]).toEqual({ op: 'CMP', arg: '>' });
    expect(code[4]).toEqual({ op: 'JMP_IF_FALSE', target: 7 });
    expect(code[5]).toEqual({ op: 'ACTION', actionId: 'breath' });
    expect(code[6]).toEqual({ op: 'WHILE_END', begin: 1 });
    expect(code[7]).toEqual({ op: 'WHILE_EXIT' });
    expect(code[8]).toEqual({ op: 'HALT' });
  });

  it('while 内 break → BREAK op', () => {
    const cond = compareBlock('qi', '>', 0);
    const result = compileWorkspace(hatWith(whileBlock(cond, breakBlock())));
    expect(result.ok).toBe(true);
    const code = result.program!.code;
    // WHILE_BEGIN, LOAD, PUSH, CMP, JMP_IF_FALSE→6, BREAK, WHILE_END, WHILE_EXIT, HALT
    expect(code[5]).toEqual({ op: 'BREAK' });
  });

  it('while 内 continue → JMP{WHILE_END pc}', () => {
    const cond = compareBlock('qi', '>', 0);
    const result = compileWorkspace(hatWith(whileBlock(cond, continueBlock())));
    expect(result.ok).toBe(true);
    const code = result.program!.code;
    // WHILE_BEGIN@0, LOAD@1, PUSH@2, CMP@3, JMP_IF_FALSE@4→6, JMP@5→6(WHILE_END), WHILE_END@6, WHILE_EXIT@7, HALT@8
    expect(code[5]).toEqual({ op: 'JMP', target: 6 });
  });

  it('break 不在循环内 → 编译错误', () => {
    const result = compileWorkspace(hatWith(breakBlock()));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('中断');
    expect(result.errors.join(' ')).toContain('循环');
  });

  it('continue 不在循环内 → 编译错误', () => {
    const result = compileWorkspace(hatWith(continueBlock()));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('继续');
    expect(result.errors.join(' ')).toContain('循环');
  });

  it('while 缺条件 → 编译错误', () => {
    const result = compileWorkspace(hatWith({
      type: 'gongfa_while',
      id: 'whl',
      inputs: { DO: { block: breath() } },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('条件');
  });

  it('while 空体 → 编译错误', () => {
    const cond = compareBlock('qi', '>', 0);
    const result = compileWorkspace(hatWith({
      type: 'gongfa_while',
      id: 'whl',
      inputs: { CONDITION: { block: cond } },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('循环体');
  });

  it('嵌套 repeat 里 break 只跳内层', () => {
    // repeat(2) { repeat(3) { break }; breath }
    const inner = repeatBlock(3, breakBlock());
    const outerWithBreath: SerializedBlock = {
      type: 'gongfa_repeat',
      id: 'rep2',
      fields: { NUM: 2 },
      inputs: { DO: { block: { ...inner, next: { block: breath('b2') } } } },
    };
    // 简化：直接测外层 repeat 里放 inner repeat + breath
    const result = compileWorkspace(hatWith(outerWithBreath));
    expect(result.ok).toBe(true);
    const code = result.program!.code;
    // 确认 BREAK 在内层循环区间里（pc < 内层 LOOP_END）
    const breakIdx = code.findIndex((op) => op.op === 'BREAK');
    expect(breakIdx).toBeGreaterThan(0);
    // 内层 LOOP_END 的 begin 应该指向内层 LOOP_BEGIN
    const innerLoopEnd = code.find((op) => op.op === 'LOOP_END' && op.begin !== 0);
    expect(innerLoopEnd).toBeDefined();
    expect(breakIdx).toBeLessThan(code.indexOf(innerLoopEnd!));
  });
});
