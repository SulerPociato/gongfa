import type { SaveStorage } from '@gongfa/core';
import { clearGongfaKeys } from './demo';

export const RESET_CONFIRM_TEXT = '确定清空全部进度？灵力、境界、功法、道具都会没。';

/**
 * 顺序是这段逻辑的全部意义：先断写入 → 再清键 → 最后 reload。
 * 反过来（先清再断，或不清就 reload）都会被 pagehide 那次 flush 把旧档写回去，
 * 表现成「按了重置、刷回来一切还在」。
 */
export function resetAllSaves(deps: {
  storage: SaveStorage;
  blockWrites: () => void;
  reload: () => void;
}): number {
  deps.blockWrites();
  const removed = clearGongfaKeys(deps.storage);
  deps.reload();
  return removed;
}
