/**
 * 悟道的「来源」账本（2026-11-26）。
 *
 * 原来悟道只有一条来源：渡劫失败 +1。顺利玩家一次不输，藏经阁永远是灰的。
 * 这里把「首次发现图案」「本境试炼首次达成」也变成确定性来源：
 *   13 种图案 × 1 + 4 个境界 × 1 = 17 点上限（不含渡劫失败）。
 * 8 套功法总价 16，所以「一帆风顺」也能学完，只差一点余量。
 *
 * 纯函数：调用方把 found / best 读出来，这里只算「该发哪些、还缺哪些」。
 * 真正写余额和账本在 insightStore.ts + App 里做。
 */
export const PATTERN_INSIGHT = 1;
export const TRIAL_INSIGHT = 1;

/** 图案来源 id：`pattern:linear`。 */
export function patternSource(id: string): string {
  return `pattern:${id}`;
}

/** 试炼来源 id：`trial:2`（境界下标）。 */
export function trialSource(realm: number): string {
  return `trial:${realm}`;
}

/** 把「已发现图案 + 已达成试炼的境界」摊成来源 id；重复的只留一份。 */
export function sourceIds(found: readonly string[], trialRealms: readonly number[]): readonly string[] {
  return [...new Set([
    ...found.map(patternSource),
    ...trialRealms.map(trialSource),
  ])];
}

/** 还没发过的来源（账本里没有的）。 */
export function missingSources(all: readonly string[], awarded: readonly string[]): readonly string[] {
  const have = new Set(awarded);
  return all.filter((id) => !have.has(id));
}

/** 一个来源值多少悟道。图案与试炼目前都是 1；写成函数是为了以后能单独调价。 */
export function insightValueOf(source: string): number {
  if (source.startsWith('pattern:')) return PATTERN_INSIGHT;
  if (source.startsWith('trial:')) return TRIAL_INSIGHT;
  return 0;
}

export function insightFromSources(sources: readonly string[]): number {
  return sources.reduce((sum, source) => sum + insightValueOf(source), 0);
}
