import type { SaveStorage } from '@gongfa/core';
import type { DaoPath } from './runtime';

/**
 * 道途（批次 7）的持久化。
 *
 * 它是**元进度**：不进 GameState、不进存档 schema（契约 §5.1 冻结）。
 *
 * 键刻意**不带槽位**（`gongfa:dao`，不是 `gongfa:dao:A`）：
 * 存档是 A/B 双槽轮换写的，按槽位存的话，写完一次存档槽位就换到另一边，
 * 刷新后 readDao 读的是空槽 —— 实测"选完守正，刷新回到未选"。
 * 道途是玩家的一次人生选择，不属于某一槽存档。
 *
 * 代价：设置抽屉的「重置存档」按 `gongfa:` 前缀清键，道途会被一起清掉，
 * 文案里已经写「全部进度」。
 */
const DAO_KEY = 'gongfa:dao';

export function readDao(storage: SaveStorage): DaoPath | null {
  const raw = storage.read(DAO_KEY);
  return raw === 'orthodox' || raw === 'heretic' ? raw : null;
}

export function writeDao(storage: SaveStorage, path: DaoPath): void {
  storage.write(DAO_KEY, path);
}
