/**
 * P2：阵修推演（Distributed Simulation）。
 *
 * 明确边界：**这是成本模型，不是真的多节点执行**。它回答一个玩家会问的问题——
 * 「加节点到底能快多少？」答案是：有同步成本，且有上限。
 *
 * 模型（教学用的最小可信模型，不是论文）：
 * - 并行收益：N 个节点理想 N 倍；
 * - 同步成本：每 tick 每个节点要等一次同步，开销 = syncSteps × (N-1) 步；
 * - 故障成本：每个节点失败就白干一轮，期望折扣 = (1 - failRate)^N；
 * - 有效加速 = N × (1-failRate)^N / (1 + syncSteps×(N-1)/workSteps)。
 *
 * 三个参数都能在界面上调，曲线会画出「最优点」——加节点到某个数之后，同步成本吃掉收益。
 */

export interface ClusterInput {
  /** 节点数 1–8。 */
  readonly nodes: number;
  /** 单节点每 tick 的工作步数（1–20）。 */
  readonly workSteps: number;
  /** 每次同步的固定成本（步，0–10）。 */
  readonly syncSteps: number;
  /** 单节点失败概率（0–0.5）。 */
  readonly failRate: number;
}

export interface ClusterResult {
  /** 有效加速比（1 = 与单节点持平）。 */
  readonly speedup: number;
  /** 每 tick 总步数（含同步开销）。 */
  readonly stepsPerTick: number;
  /** 有效吞吐（以「单节点工作量」为单位）。 */
  readonly throughput: number;
  /** 1 到 8 个节点里加速比最高的那个 N。 */
  readonly bestNodes: number;
  /** 失败带来的折扣（0–1，(1-failRate)^N）。 */
  readonly successRate: number;
}

export const CLUSTER_LIMITS = {
  nodes: { min: 1, max: 8 },
  workSteps: { min: 1, max: 20 },
  syncSteps: { min: 0, max: 10 },
  failRate: { min: 0, max: 0.5 },
} as const;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 单个 N 的加速比。抽出来是为了让 bestNodes 能扫描 1..8。 */
export function speedupOf(nodes: number, workSteps: number, syncSteps: number, failRate: number): number {
  const n = clamp(Math.round(nodes), CLUSTER_LIMITS.nodes.min, CLUSTER_LIMITS.nodes.max);
  const work = clamp(Math.round(workSteps), CLUSTER_LIMITS.workSteps.min, CLUSTER_LIMITS.workSteps.max);
  const sync = clamp(syncSteps, CLUSTER_LIMITS.syncSteps.min, CLUSTER_LIMITS.syncSteps.max);
  const fail = clamp(failRate, CLUSTER_LIMITS.failRate.min, CLUSTER_LIMITS.failRate.max);
  // 每节点每 tick 要付 (N-1) 次同步；工作步数是分母里的「有效工作量」。
  const overhead = 1 + (sync * (n - 1)) / work;
  const success = Math.pow(1 - fail, n);
  return (n * success) / overhead;
}

/**
 * 护山大阵（P2：Fault Tolerance / Quorum）。
 * 副本数 R 时，法定人数 = ⌊R/2⌋ + 1，最多容忍 R - quorum 个副本掉线。
 * 可用概率 = P(存活 ≥ quorum)，按二项分布算——这就是「为什么奇数副本更划算」的来源。
 */
export interface QuorumResult {
  readonly quorum: number;
  readonly tolerated: number;
  /** 至少 quorum 个副本存活且可用的概率（0–1）。 */
  readonly availability: number;
}

export const REPLICA_LIMITS = { min: 1, max: 5 } as const;

export function quorumOf(replicas: number, failRate: number): QuorumResult {
  const r = clamp(Math.round(replicas), REPLICA_LIMITS.min, REPLICA_LIMITS.max);
  const fail = clamp(failRate, CLUSTER_LIMITS.failRate.min, CLUSTER_LIMITS.failRate.max);
  const quorum = Math.floor(r / 2) + 1;
  const tolerated = r - quorum;

  // 二项分布：Σ_{k=quorum..r} C(r,k) (1-p)^k p^(r-k)
  let availability = 0;
  for (let alive = quorum; alive <= r; alive += 1) {
    availability += binomial(r, alive) * Math.pow(1 - fail, alive) * Math.pow(fail, r - alive);
  }
  return { quorum, tolerated, availability };
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i += 1) {
    result = (result * (n - k + i)) / i;
  }
  return result;
}

export function simulateCluster(input: ClusterInput): ClusterResult {  const n = clamp(Math.round(input.nodes), CLUSTER_LIMITS.nodes.min, CLUSTER_LIMITS.nodes.max);
  const work = clamp(Math.round(input.workSteps), CLUSTER_LIMITS.workSteps.min, CLUSTER_LIMITS.workSteps.max);
  const sync = clamp(input.syncSteps, CLUSTER_LIMITS.syncSteps.min, CLUSTER_LIMITS.syncSteps.max);
  const fail = clamp(input.failRate, CLUSTER_LIMITS.failRate.min, CLUSTER_LIMITS.failRate.max);

  const speedup = speedupOf(n, work, sync, fail);
  let bestNodes = 1;
  let bestSpeedup = speedupOf(1, work, sync, fail);
  for (let candidate = 2; candidate <= CLUSTER_LIMITS.nodes.max; candidate += 1) {
    const value = speedupOf(candidate, work, sync, fail);
    if (value > bestSpeedup + 1e-9) {
      bestSpeedup = value;
      bestNodes = candidate;
    }
  }

  return {
    speedup,
    stepsPerTick: work * n + sync * (n - 1),
    throughput: speedup,
    bestNodes,
    successRate: Math.pow(1 - fail, n),
  };
}
