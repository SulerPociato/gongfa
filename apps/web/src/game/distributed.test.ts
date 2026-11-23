import { describe, expect, it } from 'vitest';
import { CLUSTER_LIMITS, quorumOf, simulateCluster, speedupOf } from './distributed';

// P2 阵修推演：只验"模型自洽"，不验真实分布式（它不是）。
describe('阵修推演（分布式成本模型）', () => {
  it('单节点 = 1 倍速（基准）', () => {
    expect(simulateCluster({ nodes: 1, workSteps: 10, syncSteps: 3, failRate: 0 }).speedup).toBe(1);
  });

  it('同步成本为 0、无故障时，加速比就是节点数（理想并行）', () => {
    for (const nodes of [2, 4, 8]) {
      expect(speedupOf(nodes, 10, 0, 0)).toBe(nodes);
    }
  });

  it('同步成本越高，加速比越低；节点越多，边际收益越小', () => {
    const lowSync = [1, 2, 4, 8].map((n) => speedupOf(n, 10, 1, 0));
    const highSync = [1, 2, 4, 8].map((n) => speedupOf(n, 10, 5, 0));
    for (let i = 1; i < lowSync.length; i += 1) {
      expect(lowSync[i]!).toBeGreaterThan(lowSync[i - 1]!);
      expect(highSync[i]!).toBeGreaterThan(highSync[i - 1]!);
      expect(highSync[i]!).toBeLessThan(lowSync[i]!);
    }
  });

  it('故障率会吃掉收益，且节点越多惩罚越重（(1-p)^N）', () => {
    const a = speedupOf(4, 10, 1, 0);
    const b = speedupOf(4, 10, 1, 0.2);
    expect(b).toBeLessThan(a);
    expect(simulateCluster({ nodes: 4, workSteps: 10, syncSteps: 1, failRate: 0.2 }).successRate).toBeCloseTo(0.8 ** 4, 10);
  });

  it('存在最优点：同步成本高时，最佳节点数小于上限', () => {
    const result = simulateCluster({ nodes: 8, workSteps: 4, syncSteps: 10, failRate: 0 });
    expect(result.bestNodes).toBeLessThan(8);
    expect(result.bestNodes).toBeGreaterThanOrEqual(1);
  });

  it('参数越界会被夹住，不抛错也不返回 NaN', () => {
    const result = simulateCluster({ nodes: 99, workSteps: -5, syncSteps: 999, failRate: 2 });
    expect(Number.isFinite(result.speedup)).toBe(true);
    expect(result.speedup).toBeGreaterThan(0);
    expect(CLUSTER_LIMITS.nodes.max).toBe(8);
  });
});

// P2 护山大阵（Quorum）：奇数副本更划算，这是「法定人数」的核心结论。
describe('护山大阵（副本与法定人数）', () => {
  it('3 副本：法定 2、容忍 1；5 副本：法定 3、容忍 2', () => {
    expect(quorumOf(3, 0).quorum).toBe(2);
    expect(quorumOf(3, 0).tolerated).toBe(1);
    expect(quorumOf(5, 0).quorum).toBe(3);
    expect(quorumOf(5, 0).tolerated).toBe(2);
  });

  it('无故障时可用率 = 1', () => {
    expect(quorumOf(3, 0).availability).toBeCloseTo(1, 10);
  });

  it('同样容忍 1 个故障，3 副本比 4 副本更省（4 副本要 3 票）', () => {
    const three = quorumOf(3, 0.2).availability;
    const four = quorumOf(4, 0.2).availability;
    expect(three).toBeGreaterThan(four);
  });

  it('副本数不是越多越可靠：2 副本比 1 副本更差（两票都要活着）', () => {
    const one = quorumOf(1, 0.2).availability;
    const two = quorumOf(2, 0.2).availability;
    const three = quorumOf(3, 0.2).availability;
    // 2 副本的法定人数也是 2：等于要求两个都活着，反而比单副本脆
    expect(two).toBeLessThan(one);
    // 3 副本法定 2、容忍 1：容错真的加上了
    expect(three).toBeGreaterThan(one);
    expect(quorumOf(5, 0.2).availability).toBeGreaterThan(three);
  });
});
