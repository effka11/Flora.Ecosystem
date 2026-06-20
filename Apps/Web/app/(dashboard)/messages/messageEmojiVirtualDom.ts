import type { EmojiVirtualRow } from "./messageEmojiLayout";
import styles from "./messages.module.css";

const ROW_KEY_SEP = "\u0000";

export function emojiVirtualRowKey(row: EmojiVirtualRow): string {
  return `${row.categoryId}${ROW_KEY_SEP}${row.rowIndexInCategory}`;
}

export function createEmojiVirtualRowElement(row: EmojiVirtualRow): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("role", "row");
  el.className = row.isSectionEnd
    ? `${styles.messagesEmojiVirtualRow} ${styles.messagesEmojiVirtualRowSectionEnd}`
    : styles.messagesEmojiVirtualRow;
  el.style.top = `${row.offsetTop}px`;

  for (const emoji of row.emojis) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = styles.messagesEmojiChoice;
    button.dataset.emoji = emoji;
    button.textContent = emoji;
    el.appendChild(button);
  }

  return el;
}

/** Синхронизирует DOM-строки с видимым диапазоном; переиспользует узлы между кадрами. */
export function patchEmojiVirtualRows(
  body: HTMLElement,
  rows: readonly EmojiVirtualRow[],
  start: number,
  end: number,
  pool: Map<string, HTMLDivElement>,
): void {
  const needed = new Set<string>();

  for (let index = start; index < end; index++) {
    const row = rows[index];
    if (!row) continue;
    const key = emojiVirtualRowKey(row);
    needed.add(key);

    let element = pool.get(key);
    if (!element) {
      element = createEmojiVirtualRowElement(row);
      pool.set(key, element);
    } else if (element.style.top !== `${row.offsetTop}px`) {
      element.style.top = `${row.offsetTop}px`;
    }

    const nextRow = index + 1 < end ? rows[index + 1] : null;
    const nextKey = nextRow ? emojiVirtualRowKey(nextRow) : null;
    const nextInDom =
      nextKey !== null ? (pool.get(nextKey)?.parentElement === body ? pool.get(nextKey)! : null) : null;

    if (element.parentElement !== body) {
      body.insertBefore(element, nextInDom);
    } else if (element.nextSibling !== nextInDom) {
      body.insertBefore(element, nextInDom);
    }
  }

  for (const [key, element] of pool) {
    if (needed.has(key)) continue;
    element.remove();
    pool.delete(key);
  }
}
