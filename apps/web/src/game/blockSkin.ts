// 积木的「符箓」皮肤：在 thrasos 渲染器上只改圆角/凹槽/内边距，让块更像参考图里的圆角木牌。
// 不改文本布局、不改连接语义；所有尺寸都是 Blockly 自己算连接点用的常量，重建 path 后仍然自洽。
// 单独成模块是为了可回退：删掉 inject 的 renderer 字段就回到默认 thrasos。
import * as Blockly from 'blockly/core';

export const RENDERER_NAME = 'gongfa';

/** 比默认更圆、凹槽更薄；其余尺寸保持默认，避免动到 Blockly 量好的文字基线。 */
class GongfaConstants extends Blockly.blockRendering.ConstantProvider {
  override init(): void {
    super.init();
    this.CORNER_RADIUS = 10;
    this.NOTCH_WIDTH = 8;
    this.NOTCH_HEIGHT = 2;
    this.TAB_WIDTH = 8;
    this.TAB_HEIGHT = 8;
    // 基类 init 已经按默认值算过 path；改完常量必须重算一遍，否则几何与连接点对不上。
    this.NOTCH = this.makeNotch();
    this.PUZZLE_TAB = this.makePuzzleTab();
    this.INSIDE_CORNERS = this.makeInsideCorners();
    this.OUTSIDE_CORNERS = this.makeOutsideCorners();
  }
}

class GongfaRenderer extends Blockly.thrasos.Renderer {
  protected override makeConstants_(): Blockly.blockRendering.ConstantProvider {
    return new GongfaConstants();
  }
}

try {
  Blockly.blockRendering.register(RENDERER_NAME, GongfaRenderer);
} catch {
  // Vite HMR 会重新执行本模块：同名重复注册不是错误，保留第一次注册的类即可。
}
