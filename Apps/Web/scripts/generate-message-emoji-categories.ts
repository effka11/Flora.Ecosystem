/**
 * Генерирует app/(dashboard)/messages/messageEmojiCategories.ts из unicode-emoji-json (RGI).
 * Запуск: npm run generate:emoji-categories
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import groups from "unicode-emoji-json/data-by-group.json";

type EmojiEntry = string | { emoji: string };
type EmojiGroup = { name: string; slug: string; emojis: EmojiEntry[] };

function emojiChar(entry: EmojiEntry): string {
  return typeof entry === "string" ? entry : entry.emoji;
}

const GROUP_META: Record<string, { id: string; label: string }> = {
  smileys_emotion: { id: "smileys_emotion", label: "Смайлы и эмоции" },
  people_body: { id: "people_body", label: "Люди и тело" },
  animals_nature: { id: "animals_nature", label: "Природа и животные" },
  food_drink: { id: "food_drink", label: "Еда и напитки" },
  travel_places: { id: "travel_places", label: "Путешествия и места" },
  activities: { id: "activities", label: "Активности" },
  objects: { id: "objects", label: "Предметы" },
  symbols: { id: "symbols", label: "Символы" },
  flags: { id: "flags", label: "Флаги" },
};

const categories = (groups as EmojiGroup[]).map((group) => {
  const meta = GROUP_META[group.slug];
  if (!meta) throw new Error(`Unknown emoji group slug: ${group.slug}`);
  const emojis = [...new Set(group.emojis.map(emojiChar))];
  const icon = emojis[0] ?? "🙂";
  return { id: meta.id, label: meta.label, icon, emojis };
});

const total = categories.reduce((n, c) => n + c.emojis.length, 0);
const ids = categories.map((c) => c.id);

const outPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../app/(dashboard)/messages/messageEmojiCategories.ts",
);

const body = `/** Unicode RGI emoji (${total} шт., ${categories.length} категорий). Источник: unicode-emoji-json. generate: npm run generate:emoji-categories */

export const MESSAGE_EMOJI_CATEGORY_IDS = ${JSON.stringify(ids)} as const;

export type EmojiCategoryId = (typeof MESSAGE_EMOJI_CATEGORY_IDS)[number];

export type MessageEmojiCategory = {
  id: EmojiCategoryId;
  label: string;
  icon: string;
  emojis: readonly string[];
};

export const MESSAGE_EMOJI_CATEGORIES: readonly MessageEmojiCategory[] = ${JSON.stringify(categories, null, 2)} as const;
`;

writeFileSync(outPath, body, "utf8");
console.log(`Wrote ${outPath} (${total} emojis, ${categories.length} categories)`);
