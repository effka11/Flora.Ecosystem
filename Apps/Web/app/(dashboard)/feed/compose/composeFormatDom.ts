import type { ComposeFormatId } from "./composeTextFormat";

export const TOGGLEABLE_FORMAT_IDS: ComposeFormatId[] = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "mono",
  "spoiler",
  "link",
  "mention",
];

function matchesFormatElement(element: HTMLElement, formatId: ComposeFormatId): boolean {
  const tag = element.tagName.toLowerCase();
  switch (formatId) {
    case "bold":
      return (
        element.dataset.floraBold !== undefined ||
        tag === "strong" ||
        tag === "b" ||
        element.style.fontWeight === "700" ||
        element.style.fontWeight === "bold"
      );
    case "italic":
      return (
        element.dataset.floraItalic !== undefined ||
        tag === "em" ||
        tag === "i" ||
        element.style.fontStyle === "italic"
      );
    case "underline":
      return tag === "u";
    case "strikethrough":
      return tag === "s" || tag === "strike" || tag === "del";
    case "mono":
      return tag === "code";
    case "spoiler":
      return element.dataset.floraSpoiler !== undefined;
    case "link":
      return tag === "a";
    case "mention":
      return element.dataset.floraMention !== undefined;
    default:
      return false;
  }
}

function hasFormatOnNode(node: Node, editor: HTMLElement, formatId: ComposeFormatId): boolean {
  let current: Node | null = node;
  while (current && current !== editor) {
    if (current.nodeType === Node.ELEMENT_NODE && matchesFormatElement(current as HTMLElement, formatId)) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

function isTextNodeInRange(range: Range, textNode: Text): boolean {
  if (!textNode.textContent?.length) return false;
  try {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(textNode);
    const startsBeforeEnd = range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0;
    const endsAfterStart = range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0;
    return startsBeforeEnd && endsAfterStart;
  } catch {
    return false;
  }
}

function getTextNodesInRange(range: Range): Text[] {
  const ancestor = range.commonAncestorContainer;
  const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor;
  if (!root) return [];

  const result: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (isTextNodeInRange(range, node as Text)) {
      result.push(node as Text);
    }
    node = walker.nextNode();
  }
  return result;
}

export function isFormatActiveInRange(
  range: Range,
  editor: HTMLElement,
  formatId: ComposeFormatId,
): boolean {
  if (range.collapsed) {
    return hasFormatOnNode(range.startContainer, editor, formatId);
  }

  const textNodes = getTextNodesInRange(range);
  if (textNodes.length === 0) return false;
  return textNodes.every((node) => hasFormatOnNode(node, editor, formatId));
}

export function getActiveFormatsInRange(range: Range, editor: HTMLElement): ComposeFormatId[] {
  return TOGGLEABLE_FORMAT_IDS.filter((formatId) => isFormatActiveInRange(range, editor, formatId));
}

function appendStrippedNode(parent: Node, node: Node | DocumentFragment) {
  if (node instanceof DocumentFragment) {
    for (const child of Array.from(node.childNodes)) {
      parent.appendChild(child);
    }
    return;
  }
  parent.appendChild(node);
}

function stripFormatFromNode(node: Node, formatId: ComposeFormatId): Node | DocumentFragment {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.cloneNode();
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return document.createDocumentFragment();
  }

  const element = node as HTMLElement;
  if (matchesFormatElement(element, formatId)) {
    const fragment = document.createDocumentFragment();
    for (const child of Array.from(element.childNodes)) {
      appendStrippedNode(fragment, stripFormatFromNode(child, formatId));
    }
    return fragment;
  }

  const clone = element.cloneNode(false) as HTMLElement;
  for (const child of Array.from(element.childNodes)) {
    appendStrippedNode(clone, stripFormatFromNode(child, formatId));
  }
  return clone;
}

export function unwrapFormatInRange(range: Range, formatId: ComposeFormatId): void {
  const contents = range.extractContents();
  const cleaned = document.createDocumentFragment();
  for (const child of Array.from(contents.childNodes)) {
    appendStrippedNode(cleaned, stripFormatFromNode(child, formatId));
  }
  range.insertNode(cleaned);

  if (cleaned.childNodes.length > 0) {
    range.setStartBefore(cleaned.firstChild!);
    range.setEndAfter(cleaned.lastChild!);
  }
}

export function unwrapFormatAtCaret(range: Range, editor: HTMLElement, formatId: ComposeFormatId): boolean {
  let node: Node | null = range.startContainer;
  while (node && node !== editor) {
    if (node.nodeType === Node.ELEMENT_NODE && matchesFormatElement(node as HTMLElement, formatId)) {
      const element = node as HTMLElement;
      const parent = element.parentNode;
      if (!parent) return true;

      const caret = range.cloneRange();
      while (element.firstChild) {
        parent.insertBefore(element.firstChild, element);
      }
      parent.removeChild(element);
      parent.normalize();

      try {
        if (editor.contains(caret.startContainer)) {
          const maxOffset =
            caret.startContainer.nodeType === Node.TEXT_NODE
              ? (caret.startContainer.textContent?.length ?? 0)
              : caret.startContainer.childNodes.length;
          range.setStart(caret.startContainer, Math.min(caret.startOffset, maxOffset));
          range.collapse(true);
        }
      } catch {
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      return true;
    }
    node = node.parentNode;
  }
  return false;
}
