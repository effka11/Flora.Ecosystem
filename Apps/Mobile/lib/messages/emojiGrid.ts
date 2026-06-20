import type { EmojiCategoryId, MessageEmojiCategory } from "@/lib/messages/emojiCategories";

/** Синхрон с web MESSAGE_EMOJI_GRID_COLS — на узком экране 8 колонок. */
export const MOBILE_EMOJI_GRID_COLS = 8;
export const MOBILE_EMOJI_CELL_SIZE = 30;
export const MOBILE_EMOJI_CELL_GAP = 10;

export type EmojiGridRow = {
  key: string;
  emojis: readonly string[];
};

export type EmojiGridSection = {
  id: EmojiCategoryId;
  label: string;
  icon: string;
  data: EmojiGridRow[];
};

function chunkEmojis(emojis: readonly string[], cols: number): EmojiGridRow[] {
  const rows: EmojiGridRow[] = [];
  for (let i = 0; i < emojis.length; i += cols) {
    rows.push({
      key: `${i}`,
      emojis: emojis.slice(i, i + cols),
    });
  }
  return rows;
}

export function buildEmojiGridSections(
  categories: readonly MessageEmojiCategory[],
): EmojiGridSection[] {
  return categories.map((category) => ({
    id: category.id,
    label: category.label,
    icon: category.icon,
    data: chunkEmojis(category.emojis, MOBILE_EMOJI_GRID_COLS),
  }));
}

export function emojiSectionIndex(
  sections: readonly EmojiGridSection[],
  categoryId: EmojiCategoryId,
): number {
  return Math.max(
    0,
    sections.findIndex((section) => section.id === categoryId),
  );
}
