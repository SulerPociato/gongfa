import { describe, expect, it } from 'vitest';
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

describe('积木定义与内容表对齐', () => {
  it('P0 只有 tick_hat 与 breath 两块，且都映射到 actions.json 的 breath', () => {
    expect(BLOCK_DEFINITIONS.length).toBe(2);
    expect(Object.keys(BLOCK_SPECS).sort()).toEqual(['breath', 'tick_hat']);
    expect(BLOCK_SPECS['breath']?.actionId).toBe('breath');
    expect(TICK_HAT_JSON.message0).toBe('每 tick %1');
    expect(BREATH_JSON.message0).toBe('吐纳');
    expect(TOOLBOX_JSON.contents).toEqual([{ kind: 'block', type: 'breath' }]);
    expect(STARTER_WORKSPACE_JSON.blocks.blocks.length).toBe(1);
  });
});
