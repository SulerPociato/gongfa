export const TICK_MS = 100;
export const TICKS_PER_SEC = 1000 / TICK_MS;
export const BASE_BUDGET = 200;

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
