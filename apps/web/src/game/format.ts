// 变更对比的数字格式化只在这里做一次（任务 8 P0-B/P-D 共用）。
// 曲线面板的对比行和引导第 4 步说的是同一件事，两处各写一遍 toFixed 迟早分叉成两个「每秒」。

export interface CompareParts {
  readonly from: string;
  readonly to: string;
  /** 带符号的百分比整数文本（+80 / -12），不含百分号 */
  readonly percent: string;
}

export function compareParts(fromPerSec: number, toPerSec: number, percent: number): CompareParts {
  const sign = percent >= 0 ? '+' : '-';
  return {
    from: fromPerSec.toFixed(1),
    to: toPerSec.toFixed(1),
    percent: `${sign}${Math.abs(percent)}`,
  };
}
