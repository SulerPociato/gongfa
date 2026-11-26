// 窄屏积木库「点一下加一块」的落位决策（批次 19 补）。
// 抽成纯函数的原因：真正的挂接是 Blockly 的 Connection，宿主那边很难单测；
// 但「该接 BODY、接链尾还是只能浮空」是三条互斥规则，值得钉住 ——
// 原来只有「BODY 空 → 接 BODY，否则 moveBy」两条，第二块起全浮空，手机上像按钮没反应。
export type PalettePlacement = 'body' | 'chain' | 'float';

export interface PlacementInput {
  /** 新块是不是语句块（有 previousConnection）；值积木（比较 / 阵图）永远浮空 */
  readonly statement: boolean;
  /** 「每 tick」的 BODY 凹槽是否已经被占用 */
  readonly bodyConnected: boolean;
  /** BODY 链尾那块是否还有空着的 nextConnection */
  readonly tailHasNext: boolean;
}

export function palettePlacement(input: PlacementInput): PalettePlacement {
  if (!input.statement) return 'float';
  if (!input.bodyConnected) return 'body';
  return input.tailHasNext ? 'chain' : 'float';
}
