// P0 积木清单：入口 + 吐纳/调息 + 如果/循环/比较。渲染 JSON 与 IR 映射同处一文件，避免两处真相。
// actionId 若与 content/actions.json 不符，core 的 verifier 会在装载时报 action-id 错，不会静默漂移。

export const TICK_HAT_JSON = {
  kind: 'block_definition',
  type: 'tick_hat',
  message0: '每 tick %1',
  args0: [{ type: 'input_statement', name: 'BODY' }],
  style: 'gongfa_hat',
} as const;

export const BREATH_JSON = {
  kind: 'block_definition',
  type: 'breath',
  message0: '吐纳',
  previousStatement: null,
  nextStatement: null,
  style: 'gongfa_action',
} as const;

export const CALM_JSON = {
  kind: 'block_definition',
  type: 'calm',
  message0: '调息',
  previousStatement: null,
  nextStatement: null,
  style: 'gongfa_action',
} as const;

// 「否则」凹槽常驻（不做 ifelse 增删突变）：不填就是空分支，编译器按“无否则”回补跳转。
export const CONTROLS_IF_JSON = {
  kind: 'block_definition',
  type: 'controls_if',
  message0: '如果 %1 则 %2',
  args0: [
    { type: 'input_value', name: 'CONDITION', check: 'Boolean' },
    { type: 'input_statement', name: 'IF' },
  ],
  message1: '否则 %1',
  args1: [{ type: 'input_statement', name: 'ELSE' }],
  previousStatement: null,
  nextStatement: null,
  style: 'gongfa_control',
} as const;

export const CONTROLS_REPEAT_JSON = {
  kind: 'block_definition',
  type: 'controls_repeat',
  message0: '循环 %1 次 %2',
  args0: [
    { type: 'field_number', name: 'NUM', min: 1, max: 10, precision: 1, value: 3 },
    { type: 'input_statement', name: 'DO' },
  ],
  previousStatement: null,
  nextStatement: null,
  style: 'gongfa_control',
} as const;

// 左值只暴露 qi / demon / budget（IR 的 LOAD 还支持 rate / realm，P0 不给玩家选）。
export const LOGIC_COMPARE_JSON = {
  kind: 'block_definition',
  type: 'logic_compare',
  message0: '%1 %2 %3',
  args0: [
    {
      type: 'field_dropdown',
      name: 'LEFT',
      options: [
        ['存量', 'qi'],
        ['心魔', 'demon'],
        ['预算', 'budget'],
      ],
    },
    {
      type: 'field_dropdown',
      name: 'OP',
      options: [
        ['>', '>'],
        ['<', '<'],
      ],
    },
    { type: 'field_number', name: 'THRESHOLD', precision: 0.0001, value: 0.5 },
  ],
  output: 'Boolean',
  style: 'gongfa_logic',
} as const;

/**
 * 交给 `Blockly.defineBlocksWithJsonArray`。
 * 境界门控（筑基才给「如果 / 循环」）推迟到任务 6：现在工具箱一次性给全 5 块，属已知偏差。
 */
export const BLOCK_DEFINITIONS: readonly unknown[] = [TICK_HAT_JSON, BREATH_JSON, CALM_JSON, CONTROLS_IF_JSON, CONTROLS_REPEAT_JSON, LOGIC_COMPARE_JSON];

/** 开局预置：画布上只有一个入口块，玩家从工具箱拖「吐纳」进来。 */
export const STARTER_WORKSPACE_JSON = {
  blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', x: 32, y: 32 }] },
} as const;

/** 工具箱：入口块不出现（画布已预置），其余 5 块全部可选。 */
export const TOOLBOX_JSON = {
  kind: 'flyoutToolbox',
  contents: [
    { kind: 'block', type: 'breath' },
    { kind: 'block', type: 'calm' },
    { kind: 'block', type: 'controls_if' },
    { kind: 'block', type: 'controls_repeat' },
    { kind: 'block', type: 'logic_compare' },
  ],
} as const;

export interface BlockSpec {
  readonly kind: 'entry' | 'action' | 'control' | 'value';
  readonly actionId?: string | undefined;
  readonly label: string;
}

export const BLOCK_SPECS: Readonly<Record<string, BlockSpec>> = {
  tick_hat: { kind: 'entry', label: '每 tick' },
  breath: { kind: 'action', actionId: 'breath', label: '吐纳' },
  calm: { kind: 'action', actionId: 'calm', label: '调息' },
  controls_if: { kind: 'control', label: '如果' },
  controls_repeat: { kind: 'control', label: '循环' },
  logic_compare: { kind: 'value', label: '比较' },
};
