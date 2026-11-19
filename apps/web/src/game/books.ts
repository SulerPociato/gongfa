import zhoutian from '../../../../content/books/book_zhoutian.json';
import { ContentValidationError, loadBook, loadBooks, type BookDef, type GameState } from '@gongfa/core';

// 目录 = content/books/*.json 的显式列表：core 不碰 fs，谁来读文件由宿主定（与 actions/realms 同一口径）。
// 新增一本书 = 加一个 import 再加进 BOOK_ROWS。
export const BOOK_ROWS: readonly unknown[] = [zhoutian];
export const STARTER_BOOK_ID = 'book_zhoutian';

export interface BookCatalogue {
  readonly books: readonly BookDef[];
  /** 表读不起来的原因：进 HUD 红字，绝不静默给一个空目录让玩家以为「没有功法」。 */
  readonly errors: readonly string[];
}

export function readBookCatalogue(): BookCatalogue {
  try {
    return { books: loadBooks(BOOK_ROWS), errors: [] };
  } catch (error) {
    const detail = error instanceof ContentValidationError ? [...error.errors] : [(error as Error).message];
    return { books: [], errors: [`功法书表读不起来：${detail.join('；')}`] };
  }
}

// 表是静态数据，模块级读一次；坏了也照样交出去，由宿主决定怎么报。
export const BOOK_CATALOGUE: BookCatalogue = readBookCatalogue();

export interface BookLookup {
  readonly book: BookDef | null;
  readonly errors: readonly string[];
}

// 交回的一律是深拷贝（契约 §6「装载 = 深拷贝」）：宿主拿它 loadBlocks 之后不管怎么改，
// 目录本体都是原始真相，DIRTY 判定才有得比。id 为 null 就是「没装备」，不算错误。
export function bookById(catalogue: BookCatalogue, id: string | null): BookLookup {
  if (id === null) return { book: null, errors: [] };
  const result = loadBook(catalogue.books, id);
  return { book: result.book, errors: [...catalogue.errors, ...result.errors] };
}

export interface StarterGrant {
  readonly state: GameState;
  /** 补发那句提醒（灰字）；没什么可补的就是 null */
  readonly notice: string | null;
}

// D3：newGameState 的赠书只管「开新档」这条路。5A 落盘的旧档里 ownedBooks 是空的，
// 而 P0 没有别的掉落来源 —— 不补发就永远点不开「装载功法书」，所以装载后按空/非空当场补一次。
// 判据用「ownedBooks 为空且 equippedBook 为空」：拥有 ≠ 装备（契约 §5.1），装备位非空说明这本早就发过了。
// 目录里查不到开局书时不补发（补一个装不出来的 id 只会让装载按钮报错），缺书由宿主单独报红字。
export function grantStarterBook(state: GameState, catalogue: BookCatalogue): StarterGrant {
  const lookup = bookById(catalogue, STARTER_BOOK_ID);
  if (lookup.book === null) return { state, notice: null };
  if (state.ownedBooks.includes(STARTER_BOOK_ID) || state.equippedBook !== null) return { state, notice: null };
  return {
    state: { ...state, ownedBooks: [...state.ownedBooks, STARTER_BOOK_ID] },
    notice: `已补发开局功法《${lookup.book.name.zh}》`,
  };
}
