import type { ComposeMirrorSpan } from "@/app/_shared/composeFormattedText";
import { parseComposeMirrorSpans } from "@/app/_shared/composeFormattedText";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

const BOLD_INLINE = ' style="font-weight:700;font-variation-settings:\'wght\' 700"';
const ITALIC_INLINE = ' style="font-style:italic"';

function wrapVisibleSpanHtml(span: ComposeMirrorSpan): string {
  let html = escapeHtml(span.text);
  const formats = span.formats ?? {};

  if (formats.mono) html = `<code>${html}</code>`;
  if (formats.spoiler) html = `<span data-flora-spoiler="">${html}</span>`;
  if (formats.strikethrough) html = `<s>${html}</s>`;
  if (formats.underline) html = `<u>${html}</u>`;
  if (formats.italic) html = `<span data-flora-italic=""${ITALIC_INLINE}>${html}</span>`;
  if (formats.bold) html = `<span data-flora-bold=""${BOLD_INLINE}>${html}</span>`;
  if (span.href) html = `<a href="${escapeAttr(span.href)}">${html}</a>`;
  if (span.mention) html = `<span data-flora-mention="">${html}</span>`;

  return html;
}

export function markdownToComposeHtml(markdown: string): string {
  if (!markdown) return "";
  return parseComposeMirrorSpans(markdown)
    .filter((span) => !span.hidden)
    .map(wrapVisibleSpanHtml)
    .join("");
}

function nodeChildrenMarkdown(node: Node): string {
  return Array.from(node.childNodes).map(nodeToMarkdown).join("");
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const inner = nodeChildrenMarkdown(element);

  switch (tag) {
    case "br":
      return "\n";
    case "div":
    case "p":
      return inner === "" ? "" : `${inner}\n`;
    case "strong":
    case "b":
      return `**${inner}**`;
    case "em":
    case "i":
      return `*${inner}*`;
    case "u":
      return `__${inner}__`;
    case "s":
    case "strike":
    case "del":
      return `~~${inner}~~`;
    case "code":
      return `\`${inner}\``;
    case "a": {
      const href = element.getAttribute("href") ?? "";
      return `[${inner}](${href})`;
    }
    case "span": {
      if (element.dataset.floraSpoiler !== undefined) return `||${inner}||`;
      if (element.dataset.floraMention !== undefined) return inner;
      if (element.dataset.floraBold !== undefined) return `**${inner}**`;
      if (element.dataset.floraItalic !== undefined) return `*${inner}*`;
      return inner;
    }
    default:
      return inner;
  }
}

export function composeHtmlToMarkdown(html: string): string {
  if (!html || html === "<br>") return "";

  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";

  return nodeToMarkdown(root).replace(/\n+$/g, "");
}
