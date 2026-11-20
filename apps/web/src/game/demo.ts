import type { Qi, RealmDef, SaveStorage } from '@gongfa/core';

/**
 * 演示模式（?demo=1）的纯逻辑：倍速、跳关落点、清档标记。
 * 这里不 import DOM / runtime：能纯函数化才说明「跳到哪、快多少」是查表算出来的事实，
 * 而不是散在组件里的字面量。真正的状态改写留在 runtime，DOM 侧留在 App。
 */

/** 裁定 3：倍速只改真实时间里跑多少 tick，HUD 的「/ 秒」仍是每模拟秒的模型速率。 */
export const DEMO_SPEED = 3;

/** 「达标前 5%」的那 5%。 */
export const DEMO_JUMP_FRACTION = 0.95;

/** 跳关要停在「下一境＝元婴」的那一站，也就是它的前一行（金丹）：阈值挂在当前境那一行。 */
export const DEMO_JUMP_NEXT_REALM = '元婴';

/** 清档标记放 sessionStorage：它要活过一次 reload，又不能被这次清档顺手清掉。 */
export const DEMO_RESET_KEY = 'gongfa:demo-reset';

export function demoSpeed(demo: boolean): number {
  return demo ? DEMO_SPEED : 1;
}

export interface DemoJumpTarget {
  readonly realmIndex: number;
  readonly realmName: string;
  readonly qi: Qi;
}

/**
 * 跳关落点全部从 realms.json 现算：表把金丹阈值改成 1e6，这里就跟着给 950000，
 * 代码里留 114000 这种数就是第二套口径。找不到目标境（表里没有元婴 / 它排在首行）返回 null，
 * 由调用方决定怎么告诉玩家，不静默退回首境。
 */
export function demoJumpTarget(
  realms: readonly RealmDef[],
  fraction: number = DEMO_JUMP_FRACTION,
): DemoJumpTarget | null {
  const next = realms.findIndex((realm) => realm.name.zh === DEMO_JUMP_NEXT_REALM);
  if (next < 1) return null;
  const realm = realms[next - 1] as RealmDef;
  return { realmIndex: next - 1, realmName: realm.name.zh, qi: realm.threshold * fraction };
}

export interface DemoFlagStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

export function requestDemoReset(store: DemoFlagStore): void {
  store.write(DEMO_RESET_KEY, '1');
}

/** 读一次就自删：StrictMode 会挂载两次，标记留着第二次挂载会把刚写回的新档又清一遍。 */
export function consumeDemoReset(store: DemoFlagStore): boolean {
  if (store.read(DEMO_RESET_KEY) !== '1') return false;
  store.remove(DEMO_RESET_KEY);
  return true;
}

/** 只清这个游戏自己的命名空间（core 的 keys() 已经按 gongfa: 前缀筛过），返回删掉的条数。 */
export function clearGongfaKeys(storage: SaveStorage): number {
  const keys = storage.keys();
  for (const key of keys) storage.remove(key);
  return keys.length;
}
