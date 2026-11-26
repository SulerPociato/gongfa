// 主题只改颜色，不碰渲染器。
// 2026-11-26 皮肤轮：从「实心积木」改成「墨底 + 亮描边」——参考图的读法。
// 具体描边/发光在 global.css 里按块型类名覆盖（theme 的 primary 仍作为兜底填充）。
// packages/blocks 不依赖 Blockly：这里只导出纯对象。

export const INK = '#070C0E'; // 底色（墨黑）
export const SPIRIT = '#35E0C8'; // 主色（灵气青）：连线、插入标记、滚动条
export const PAPER = '#0B1417'; // 深墨（块体填充的兜底色）
export const GOLD = '#E8C978'; // 强调（符纸金）
export const CINNABAR = '#FF7B63'; // 朱砂（条件/内层分支）
export const JADE = '#9FE8DD'; // 淡青（值块）
export const TEXT = '#E9F6F3'; // 块文字：米白，不再用纯青（长标签更耐读）

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

const style = (fill: string, edge: string): { colourPrimary: string; colourSecondary: string; colourTertiary: string } => ({
  colourPrimary: fill,
  colourSecondary: fill,
  colourTertiary: edge,
});

export const GONGFA_THEME: ThemeJson = {
  name: 'gongfa',
  blockStyles: {
    gongfa_hat: { ...style('#0B2426', '#8FF5E6'), hat: 'cap' },
    gongfa_action: style('#071A1C', SPIRIT),
    gongfa_control: style('#1A1408', GOLD),
    gongfa_logic: style('#1C0D0A', CINNABAR),
    gongfa_value: style('#08181A', JADE),
  },
  componentStyles: {
    workspaceBackgroundColour: INK,
    toolboxBackgroundColour: INK,
    toolboxSelectedBackgroundColour: PAPER,
    flyoutBackgroundColour: PAPER,
    flyoutOpacity: 0.94,
    // 「连线」= 拖拽时的插入标记 + 连接高亮，两者都给灵气青
    insertionMarkerColour: SPIRIT,
    insertionMarkerOpacity: 0.35,
    markerColour: SPIRIT,
    markerOpacity: 0.7,
    cursorColour: SPIRIT,
    scrollbarColour: SPIRIT,
  },
  fontStyle: { colour: TEXT },
};
