// 契约 §4.3 的 stall 事件；divZero 是非常量除零的运行期落点（待补进契约 §4.4）。
export type StallReason = 'budget' | 'loopLimit' | 'divZero';

export interface StallEvent {
  readonly t: 'stall';
  readonly programId: string;
  readonly pc: number;
  readonly steps: number;
  readonly tick: number;
  readonly reason: StallReason;
}

export type VmEvent = StallEvent;
