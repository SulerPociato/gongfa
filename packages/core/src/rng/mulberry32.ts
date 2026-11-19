import type { Rng } from '../types';

const UINT32 = 0x1_0000_0000;
const STEP = 0x6d2b79f5;
const GOLDEN = 0x9e3779b9;
const MIX_B = 0x85ebca77;
const MIX_C = 0x27d4eb2f;

// 架构 §2.6 的 Rng 端口实现，逐位对齐 01-design §4.4 的杂念规则与任务 10 的 balance-sim.py。
// 每一步都用 >>> 0 收在 uint32：经典写法让 a 当 float 一路加下去，输出虽然相同，
// 但跨语言复刻时「什么时候取模」要额外解释，Python 侧照本写法可以逐行搬。
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + STEP) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
      t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / UINT32;
    },
  };
}

// 把 (seed, index) 搅成一个 uint32 状态。三个常数取自 MurmurHash3 的 finalizer，
// 目的是让相邻 tick 的首个输出不再相关——直接 mulberry32(seed + tick) 会把这种相关性留在序列里。
function mixSeed(seed: number, index: number): number {
  let h = (seed ^ GOLDEN) >>> 0;
  h = Math.imul(h ^ (index >>> 0), MIX_B) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, MIX_C) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

// 按 (seed, index) 定位取一个 [0,1)。刻意的无状态设计：
// GameState（契约 §5.1）里没有 RNG 游标字段，有状态生成器一读档就从 0 重启，
// 在线序列与「从种子重放」（§7.2 离线渡劫、任务 12 回放）必然分叉；补游标就得升 schema v2 走迁移链。
export function drawAt(seed: number, index: number): number {
  return mulberry32(mixSeed(seed, index)).next();
}
