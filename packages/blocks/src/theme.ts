// 主题只改颜色，不碰渲染器（10-dev-playbook 配色表里的三个值）。
// 导出纯对象，由 apps/web 交给 `Blockly.Theme.defineTheme('gongfa', GONGFA_THEME)`，packages/blocks 因此不依赖 Blockly。

export const INK = '#0A0E12'; // 底色（墨黑）
export const SPIRIT = '#35E0C8'; // 主色（灵气青）：连线、插入标记、滚动条、块名文字
export const PAPER = '#1C2228'; // 面板（宣纸灰）：块体填充

export interface ThemeJson {
  readonly name: string;
  readonly blockStyles: Record<
    string,
    {
      readonly colourPrimary: string;
      readonly colourSecondary: string;
      readonly colourTertiary: string;
      readonly hat?: string | undefined;
    }
  >;
  readonly componentStyles: Record<string, string | number>;
  readonly fontStyle: { readonly colour: string };
}

export const GONGFA_THEME: ThemeJson = {
  name: 'gongfa',
  blockStyles: {
    gongfa_hat: { colourPrimary: SPIRIT, colourSecondary: PAPER, colourTertiary: INK, hat: 'cap' },
    gongfa_action: { colourPrimary: PAPER, colourSecondary: SPIRIT, colourTertiary: SPIRIT },
  },
  componentStyles: {
    workspaceBackgroundColour: INK,
    toolboxBackgroundColour: INK,
    toolboxSelectedBackgroundColour: PAPER,
    flyoutBackgroundColour: PAPER,
    flyoutOpacity: 0.85,
    // 「连线」= 拖拽时的插入标记 + 连接高亮，两者都给灵气青
    insertionMarkerColour: SPIRIT,
    insertionMarkerOpacity: 0.4,
    markerColour: SPIRIT,
    markerOpacity: 0.7,
    cursorColour: SPIRIT,
    scrollbarColour: SPIRIT,
  },
  fontStyle: { colour: SPIRIT },
};
