export const TICK_MS = 100;
export const TICKS_PER_SEC = 1000 / TICK_MS;
export const BASE_BUDGET = 200;

// 契约 §2.2.1 心魔增长基线；任务 10 的校准区间 0.00004–0.00005 通过 SettleDeps.demonBase 注入。
export const DEMON_BASE_PER_ACTION = 0.00005;

// core 访问外部的唯一通道（02-architecture §2.6）；任务 5/7 起被 save/offline 使用。
export interface Storage {
  load(): string | null;
  save(value: string): void;
  clear(): void;
}

export interface Clock {
  now(): number;
}

export interface Rng {
  next(): number;
}
