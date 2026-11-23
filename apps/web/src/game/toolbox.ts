import { TOOLBOX_JSON } from '@gongfa/blocks';

// 工具箱的门控表：块型 → 最低境界下标（契约 §4.3 的「解锁」列）。
// 没在这张表里的（每 tick / 吐纳 / 调息 / 比较）炼气就给。固化不列进来 —— 书是开局赠送的，
// 01-design §5.2.1 的「抄模板 → 改模板」没有境界门槛，卡住它等于把 P0 的成长路径拦腰截断。
export const MIN_REALM: Record<string, number> = {
  gongfa_if: 1,
  gongfa_repeat: 1,
  gongfa_break: 2,
  gongfa_continue: 2,
  gongfa_while: 3,
  // 批次 13（P1 沙漏）：金丹解锁。它要求玩家已经会用循环，否则"分批"没有对象。
  gongfa_batch: 2,
  // 批次 26：阵图要等玩家已经会看「灵力/步」才给（金丹）。
  gongfa_array: 2,
  gongfa_array_rune: 2,
};

type ToolboxContent = (typeof TOOLBOX_JSON.contents)[number];

export interface ToolboxJson {
  readonly kind: 'flyoutToolbox';
  readonly contents: readonly ToolboxContent[];
}

// 演示模式（?demo=1）全开：01-design §11.4「演示模式强制全开」，评审第一眼就能看到整套积木。
// hidden 是任务 8 P0-C 的引导层：只在第一次进游戏的前几步临时藏掉「调息 / 比较」，
// 它叠在境界门控之上、不替换境界门控 —— 藏的是 ToolboxJson 里的条目，画布上已有的积木一块不动。
export function toolboxForRealm(realmIndex: number, openAll: boolean, hidden: readonly string[] = []): ToolboxJson {
  const contents = TOOLBOX_JSON.contents.filter(
    (item) => (openAll || (MIN_REALM[item.type] ?? 0) <= realmIndex) && !hidden.includes(item.type),
  );
  return { kind: 'flyoutToolbox', contents };
}

// 「还差哪几块」：提示语要按当前境界说出来，而不是让玩家自己猜下一境给什么。
export function lockedCount(realmIndex: number, openAll: boolean): number {
  if (openAll) return 0;
  return TOOLBOX_JSON.contents.filter((item) => (MIN_REALM[item.type] ?? 0) > realmIndex).length;
}
