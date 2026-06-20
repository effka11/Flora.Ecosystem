/** Символы, допустимые в никнейме (как LatinIdentifiers.IsAllowedUsernameChar). */
export function isUsernameChar(char: string): boolean {
  if (char.length !== 1) return false;
  const c = char.charCodeAt(0);
  return (
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === 95
  );
}

/** Завершает ввод @-запроса и создаёт карточку упоминания. */
export function isMentionTerminator(char: string): boolean {
  return char.length === 1 && !isUsernameChar(char);
}

export function normalizeMentionUsername(raw: string): string {
  const stripped = raw.trim().replace(/^@+/, "");
  return [...stripped].filter(isUsernameChar).join("").slice(0, 50);
}

export type CommentTextPart =
  | { kind: "text"; value: string }
  | { kind: "mention"; username: string };

/** Разбирает plain-текст комментария на фрагменты и @упоминания. */
export function parseCommentTextParts(content: string): CommentTextPart[] {
  if (!content) return [{ kind: "text", value: "" }];

  const parts: CommentTextPart[] = [];
  let cursor = 0;
  let index = 0;

  while (index < content.length) {
    const ch = content[index]!;
    if (ch === "@" && (index === 0 || !isUsernameChar(content[index - 1]!))) {
      let end = index + 1;
      while (end < content.length && isUsernameChar(content[end]!)) end += 1;
      const username = content.slice(index + 1, end);
      if (username.length >= 2) {
        if (index > cursor) parts.push({ kind: "text", value: content.slice(cursor, index) });
        parts.push({ kind: "mention", username });
        cursor = end;
        index = end;
        continue;
      }
    }
    index += 1;
  }

  if (cursor < content.length) parts.push({ kind: "text", value: content.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: "text", value: content }];
}

/** Минимальный контракт для пулов никнеймов (без зависимости от socialApi). */
export type MentionUserCandidate = {
  username: string;
  displayName: string;
};

export function findKnownUsername(
  raw: string,
  pools: readonly MentionUserCandidate[],
): string | null {
  const q = normalizeMentionUsername(raw).toLowerCase();
  if (q.length < 2) return null;
  for (const u of pools) {
    if (u.username.toLowerCase() === q) return u.username;
  }
  return null;
}

export function isExactMentionMatch(query: string, resolvedUsername: string): boolean {
  return (
    normalizeMentionUsername(query).toLowerCase() ===
    normalizeMentionUsername(resolvedUsername).toLowerCase()
  );
}

export type MentionQueryContext = {
  textNode: Text;
  startOffset: number;
  endOffset: number;
  query: string;
};

export function getMentionQueryAtCaret(root: HTMLElement): MentionQueryContext | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const textNode = range.startContainer as Text;
  const parentEl = textNode.parentElement;
  if (parentEl?.closest("[data-mention-username]")) return null;

  const text = textNode.data;
  const offset = range.startOffset;
  const before = text.slice(0, offset);
  const atIndex = before.lastIndexOf("@");
  if (atIndex < 0) return null;

  const charBeforeAt = atIndex > 0 ? before[atIndex - 1]! : " ";
  if (charBeforeAt !== "" && !/\s/.test(charBeforeAt)) return null;

  const query = before.slice(atIndex + 1);
  if (query.length > 0 && !query.split("").every(isUsernameChar)) return null;

  return { textNode, startOffset: atIndex, endOffset: offset, query };
}

export function createMentionChip(username: string, chipClassName: string): HTMLSpanElement {
  const normalized = normalizeMentionUsername(username);
  const span = document.createElement("span");
  span.className = chipClassName;
  span.contentEditable = "false";
  span.dataset.mentionUsername = normalized;
  span.textContent = `@${normalized}`;
  return span;
}

export function editorToPlainText(root: HTMLElement): string {
  let out = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\u200b/g, "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const mention = node.dataset.mentionUsername;
    if (mention) {
      out += `@${mention}`;
      return;
    }
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return out;
}

export function isEditorEmpty(root: HTMLElement): boolean {
  return editorToPlainText(root).trim().length === 0;
}

export function placeCaretAfter(node: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function placeCaretInText(textNode: Text, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(textNode, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function abandonMentionQuery(ctx: MentionQueryContext, suffix: string): boolean {
  const { textNode, endOffset } = ctx;
  if (!textNode.isConnected) return false;
  if (textNode.parentElement?.closest("[data-mention-username]")) return false;

  const before = textNode.data.slice(0, endOffset);
  const after = textNode.data.slice(endOffset);
  textNode.data = `${before}${suffix}${after}`;
  placeCaretInText(textNode, endOffset + suffix.length);
  return true;
}

export function commitMentionQuery(
  ctx: MentionQueryContext,
  username: string,
  chipClassName: string,
  suffix = "",
  options?: { allowPartialQuery?: boolean },
): boolean {
  const normalized = normalizeMentionUsername(username);
  if (normalized.length < 2) return false;
  if (!options?.allowPartialQuery && !isExactMentionMatch(ctx.query, normalized)) return false;

  const { textNode, startOffset, endOffset } = ctx;
  if (!textNode.isConnected) return false;
  const parent = textNode.parentNode;
  if (!parent) return false;

  const before = textNode.data.slice(0, startOffset);
  const after = textNode.data.slice(endOffset);
  const chip = createMentionChip(normalized, chipClassName);

  const frag = document.createDocumentFragment();
  if (before) frag.appendChild(document.createTextNode(before));
  frag.appendChild(chip);
  const tail = `${suffix}${after}`;
  const tailNode = document.createTextNode(tail || "\u200b");
  frag.appendChild(tailNode);
  parent.replaceChild(frag, textNode);
  placeCaretInText(tailNode, suffix.length || (tail === "\u200b" ? 1 : 0));
  return true;
}

export function insertMentionChipAtCaret(
  root: HTMLElement,
  username: string,
  chipClassName: string,
  suffix = "",
): void {
  const normalized = normalizeMentionUsername(username);
  if (!normalized) return;
  root.focus();
  const sel = window.getSelection();
  if (!sel) return;

  let range: Range;
  if (sel.rangeCount > 0 && root.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
  }

  range.deleteContents();
  const chip = createMentionChip(normalized, chipClassName);
  const tailNode = document.createTextNode(suffix || "\u200b");
  range.insertNode(tailNode);
  range.insertNode(chip);
  placeCaretInText(tailNode, suffix.length || 1);
}

export function insertTextAtCaret(root: HTMLElement, text: string): void {
  root.focus();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return;
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function removeMentionChipBeforeCaret(root: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return false;

  const { startContainer, startOffset } = range;
  let chip: HTMLElement | null = null;

  if (startContainer.nodeType === Node.TEXT_NODE) {
    const textNode = startContainer as Text;
    const parent = textNode.parentNode;
    if (!parent) return false;
    if (startOffset === 0) {
      const prev = textNode.previousSibling;
      if (prev instanceof HTMLElement && prev.dataset.mentionUsername) chip = prev;
    } else if (startOffset === 1 && textNode.data === "\u200b") {
      const prev = textNode.previousSibling;
      if (prev instanceof HTMLElement && prev.dataset.mentionUsername) {
        chip = prev;
        textNode.remove();
      }
    }
  } else if (startContainer instanceof HTMLElement) {
    const child = startContainer.childNodes[startOffset - 1];
    if (child instanceof HTMLElement && child.dataset.mentionUsername) chip = child;
  }

  if (!chip) return false;
  const next = chip.nextSibling;
  if (next?.nodeType === Node.TEXT_NODE && (next as Text).data === "\u200b") next.remove();
  chip.remove();
  return true;
}

export function getCaretRect(root: HTMLElement): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  if (!root.contains(range.startContainer)) return null;
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[0]!;
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  range.insertNode(marker);
  const rect = marker.getBoundingClientRect();
  marker.remove();
  return rect;
}
