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

/**
 * 闭关报告的时长文案（契约 §7.2 封顶 60 分钟）。
 * 原来直接印「60分0秒」——玩家读起来像计时器卡住了；满一小时就写「1小时」。
 * 秒向下取整：报告是给「离开了多久」的概览，不需要毫秒级精确。
 */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}分${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (restMinutes === 0 && seconds === 0) return `${hours}小时`;
  if (seconds === 0) return `${hours}小时${restMinutes}分`;
  if (restMinutes === 0) return `${hours}小时${seconds}秒`;
  return `${hours}小时${restMinutes}分${seconds}秒`;
}
