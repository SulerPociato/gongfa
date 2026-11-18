// P0 积木清单：一个事件块 + 一个动作块。渲染 JSON 与 IR 映射同处一文件，避免两处真相。
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

/** 交给 `Blockly.defineBlocksWithJsonArray`。 */
export const BLOCK_DEFINITIONS: readonly unknown[] = [TICK_HAT_JSON, BREATH_JSON];

/** 开局预置：画布上只有一个入口块，玩家从工具箱拖「吐纳」进来。 */
export const STARTER_WORKSPACE_JSON = {
  blocks: { languageVersion: 0, blocks: [{ type: 'tick_hat', x: 32, y: 32 }] },
} as const;

/** 工具箱只放 breath（其余块随任务 4 解锁）。 */
export const TOOLBOX_JSON = {
  kind: 'flyoutToolbox',
  contents: [{ kind: 'block', type: 'breath' }],
} as const;

export interface BlockSpec {
  readonly kind: 'entry' | 'action';
  readonly actionId?: string | undefined;
  readonly label: string;
}

export const BLOCK_SPECS: Readonly<Record<string, BlockSpec>> = {
  tick_hat: { kind: 'entry', label: '每 tick' },
  breath: { kind: 'action', actionId: 'breath', label: '吐纳' },
};
