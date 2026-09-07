import { getViewportFrame } from "@/app/_shared/viewportFrame";
import type { EmojiCategoryId, MessageEmojiCategory } from "./messageEmojiCategories";

/** Синхрон с --messages-emoji-grid-cols в messages.module.css */
export const MESSAGE_EMOJI_GRID_COLS = 10;

/** Первичная сетка: зазор категория ↔ линия разделения (сверху и снизу линии по 2 кл.). */
const EMOJI_SECTION_GAP_CELLS = 2;
const SECTION_DIVIDER_PX = 1;

type EmojiLayoutMetrics = {
  cell: number;
  rowGap: number;
  rowStride: number;
  sectionPadY: number;
  gridInset: number;
  divider: number;
};

function emojiLayoutMetrics(): EmojiLayoutMetrics {
  const { step, stepFine } = getViewportFrame();
  const cell = 2 * step;
  const rowGap = 2 * stepFine;
  return {
    cell,
    rowGap,
    rowStride: cell + rowGap,
    sectionPadY: EMOJI_SECTION_GAP_CELLS * step,
    gridInset: step,
    divider: SECTION_DIVIDER_PX,
  };
}

/** Запас строк сверху/снизу viewport при виртуализации. */
export const EMOJI_VIRTUAL_OVERSCAN_ROWS = 2;

export type EmojiVirtualRow = {
  categoryId: EmojiCategoryId;
  rowIndexInCategory: number;
  offsetTop: number;
  emojis: readonly string[];
  isSectionEnd: boolean;
};

export type EmojiVirtualSection = {
  categoryId: EmojiCategoryId;
  label: string;
  offsetTop: number;
  firstRowOffsetTop: number;
  height: number;
};

export type EmojiVirtualModel = {
  sections: readonly EmojiVirtualSection[];
  rows: readonly EmojiVirtualRow[];
  /** offsetTop по индексу строки — быстрый бинарный поиск без доступа к объектам. */
  rowOffsetTops: readonly number[];
  /** Индекс секции для каждой строки — синхронизация rail без чтения row.categoryId. */
  sectionIndexByRow: readonly number[];
  sectionByCategoryId: ReadonlyMap<EmojiCategoryId, EmojiVirtualSection>;
  totalHeight: number;
};

const VIRTUAL_MODEL_LAYOUT_VERSION = 5;

let cachedVirtualModel: EmojiVirtualModel | null = null;
let cachedVirtualModelLayoutVersion = 0;
let cachedVirtualModelStep = 0;

export function buildEmojiVirtualModel(
  categories: readonly MessageEmojiCategory[],
): EmojiVirtualModel {
  const { cell, rowGap, sectionPadY, divider } = emojiLayoutMetrics();
  const sections: EmojiVirtualSection[] = [];
  const rows: EmojiVirtualRow[] = [];
  const rowOffsetTops: number[] = [];
  const sectionIndexByRow: number[] = [];
  const sectionByCategoryId = new Map<EmojiCategoryId, EmojiVirtualSection>();
  let offsetTop = 0;

  for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex++) {
    const category = categories[categoryIndex];
    if (categoryIndex > 0) offsetTop += sectionPadY;

    const sectionStart = offsetTop;
    const firstRowOffsetTop = offsetTop;
    const rowCount = Math.ceil(category.emojis.length / MESSAGE_EMOJI_GRID_COLS);

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const isLastRow = rowIndex === rowCount - 1;
      const emojiStart = rowIndex * MESSAGE_EMOJI_GRID_COLS;
      rows.push({
        categoryId: category.id,
        rowIndexInCategory: rowIndex,
        offsetTop,
        emojis: category.emojis.slice(emojiStart, emojiStart + MESSAGE_EMOJI_GRID_COLS),
        isSectionEnd: isLastRow,
      });
      rowOffsetTops.push(offsetTop);
      sectionIndexByRow.push(categoryIndex);
      offsetTop += cell;
      if (isLastRow) {
        offsetTop += sectionPadY + divider;
      } else {
        offsetTop += rowGap;
      }
    }

    const section: EmojiVirtualSection = {
      categoryId: category.id,
      label: category.label,
      offsetTop: sectionStart,
      firstRowOffsetTop,
      height: offsetTop - sectionStart,
    };
    sections.push(section);
    sectionByCategoryId.set(category.id, section);
  }

  return {
    sections,
    rows,
    rowOffsetTops,
    sectionIndexByRow,
    sectionByCategoryId,
    totalHeight: offsetTop,
  };
}

/** Одна модель на сессию шаблона сетки — данные категорий статичны. */
export function getEmojiVirtualModel(
  categories: readonly MessageEmojiCategory[],
): EmojiVirtualModel {
  const step = getViewportFrame().step;
  if (
    !cachedVirtualModel ||
    cachedVirtualModelLayoutVersion !== VIRTUAL_MODEL_LAYOUT_VERSION ||
    cachedVirtualModelStep !== step
  ) {
    cachedVirtualModel = buildEmojiVirtualModel(categories);
    cachedVirtualModelLayoutVersion = VIRTUAL_MODEL_LAYOUT_VERSION;
    cachedVirtualModelStep = step;
  }
  return cachedVirtualModel;
}

export function findRowIndexAtOrBefore(offsetTops: readonly number[], offsetTop: number): number {
  if (offsetTops.length === 0) return 0;
  let lo = 0;
  let hi = offsetTops.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsetTops[mid] <= offsetTop) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export function findEmojiVisibleRowRange(
  model: EmojiVirtualModel,
  scrollTop: number,
  viewportHeight: number,
  overscanRows: number = EMOJI_VIRTUAL_OVERSCAN_ROWS,
): { start: number; end: number } {
  const { rowOffsetTops, rows } = model;
  if (rows.length === 0) return { start: 0, end: 0 };

  const { rowStride } = emojiLayoutMetrics();
  const overscanPx = overscanRows * rowStride;
  const start = findRowIndexAtOrBefore(rowOffsetTops, scrollTop - overscanPx);

  const viewportPx = viewportHeight > 0 ? viewportHeight : rowStride * 12;
  const end = Math.min(
    rows.length,
    Math.max(
      start + 1,
      findRowIndexAtOrBefore(rowOffsetTops, scrollTop + viewportPx + overscanPx) + 1,
    ),
  );
  return { start, end };
}

export function estimateEmojiCategorySectionHeight(
  emojiCount: number,
  options?: { isFirst?: boolean },
): number {
  const { cell, rowGap, sectionPadY, gridInset, divider } = emojiLayoutMetrics();
  if (emojiCount <= 0) {
    return options?.isFirst ? gridInset : sectionPadY;
  }
  const rowCount = Math.ceil(emojiCount / MESSAGE_EMOJI_GRID_COLS);
  const gridHeight = rowCount * cell + Math.max(0, rowCount - 1) * rowGap;
  const topPad = options?.isFirst ? 0 : sectionPadY;
  const wrapTopInset = options?.isFirst ? gridInset : 0;
  return wrapTopInset + topPad + gridHeight + sectionPadY + divider;
}

/** Сколько категорий в RGI-наборе (для CSS без загрузки data). */
export const MESSAGE_EMOJI_CATEGORY_COUNT = 9;
