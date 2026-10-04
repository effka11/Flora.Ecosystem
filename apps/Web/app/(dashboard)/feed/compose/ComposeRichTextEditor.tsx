"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ComposeFormatId } from "./composeTextFormat";
import { composeHtmlToMarkdown, markdownToComposeHtml } from "./composeMarkdownBridge";
import {
  getActiveFormatsInRange,
  isFormatActiveInRange,
  unwrapFormatAtCaret,
  unwrapFormatInRange,
} from "./composeFormatDom";
import styles from "./compose.module.css";

export type ComposeRichTextEditorHandle = {
  focus: () => void;
  applyFormat: (formatId: ComposeFormatId) => void;
  insertText: (value: string) => void;
};

type ComposeRichTextEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  onActiveFormatsChange?: (formats: ComposeFormatId[]) => void;
  placeholder?: string;
  maxLength?: number;
  "aria-label"?: string;
};

const BOLD_STYLE: Partial<CSSStyleDeclaration> = {
  fontWeight: "700",
  fontVariationSettings: "'wght' 700",
};

const ITALIC_STYLE: Partial<CSSStyleDeclaration> = {
  fontStyle: "italic",
};

function applyInlineStyle(el: HTMLElement, style: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, style);
}

function wrapRangeIn(range: Range, tag: string): HTMLElement {
  const el = document.createElement(tag);
  const fragment = range.extractContents();
  el.appendChild(fragment);
  range.insertNode(el);
  return el;
}

function wrapRangeInSpan(
  range: Range,
  dataset: Record<string, string>,
  style?: Partial<CSSStyleDeclaration>,
): HTMLSpanElement {
  const span = document.createElement("span");
  for (const [key, value] of Object.entries(dataset)) {
    span.dataset[key] = value;
  }
  if (style) applyInlineStyle(span, style);
  const fragment = range.extractContents();
  span.appendChild(fragment);
  range.insertNode(span);
  return span;
}

function insertPlaceholderSpan(
  range: Range,
  dataset: Record<string, string>,
  style: Partial<CSSStyleDeclaration> | undefined,
  placeholder: string,
): HTMLSpanElement {
  range.deleteContents();
  const span = document.createElement("span");
  for (const [key, value] of Object.entries(dataset)) {
    span.dataset[key] = value;
  }
  if (style) applyInlineStyle(span, style);
  span.textContent = placeholder;
  range.insertNode(span);
  return span;
}

function placeCaretAfter(sel: Selection, el: Node) {
  const range = document.createRange();
  range.setStartAfter(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function selectNodeContents(sel: Selection, el: Node) {
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

export const ComposeRichTextEditor = forwardRef<ComposeRichTextEditorHandle, ComposeRichTextEditorProps>(
  function ComposeRichTextEditor(
    { value, onChange, onActiveFormatsChange, placeholder, maxLength, "aria-label": ariaLabel },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    const syncingFromPropsRef = useRef(false);
    const lastMarkdownRef = useRef(value);
    const savedRangeRef = useRef<Range | null>(null);

    const syncMarkdownFromEditor = useCallback(() => {
      const editor = editorRef.current;
      if (!editor || syncingFromPropsRef.current) return;
      let markdown = composeHtmlToMarkdown(editor.innerHTML);
      if (maxLength !== undefined && markdown.length > maxLength) {
        markdown = markdown.slice(0, maxLength);
        syncingFromPropsRef.current = true;
        editor.innerHTML = markdownToComposeHtml(markdown);
        syncingFromPropsRef.current = false;
      }
      lastMarkdownRef.current = markdown;
      onChange(markdown);
    }, [maxLength, onChange]);

    const publishActiveFormats = useCallback(() => {
      const editor = editorRef.current;
      if (!editor || !onActiveFormatsChange) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        onActiveFormatsChange([]);
        return;
      }

      const range = sel.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) {
        onActiveFormatsChange([]);
        return;
      }

      onActiveFormatsChange(getActiveFormatsInRange(range, editor));
    }, [onActiveFormatsChange]);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;
      if (value === lastMarkdownRef.current) return;
      syncingFromPropsRef.current = true;
      editor.innerHTML = markdownToComposeHtml(value);
      lastMarkdownRef.current = value;
      syncingFromPropsRef.current = false;
      publishActiveFormats();
    }, [value, publishActiveFormats]);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor || !onActiveFormatsChange) return;

      const handleSelectionChange = () => publishActiveFormats();

      document.addEventListener("selectionchange", handleSelectionChange);
      editor.addEventListener("keyup", handleSelectionChange);
      editor.addEventListener("mouseup", handleSelectionChange);
      editor.addEventListener("focus", handleSelectionChange);

      return () => {
        document.removeEventListener("selectionchange", handleSelectionChange);
        editor.removeEventListener("keyup", handleSelectionChange);
        editor.removeEventListener("mouseup", handleSelectionChange);
        editor.removeEventListener("focus", handleSelectionChange);
      };
    }, [onActiveFormatsChange, publishActiveFormats]);

    const saveSelection = useCallback(() => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        savedRangeRef.current = sel.getRangeAt(0).cloneRange();
      }
      publishActiveFormats();
    }, [publishActiveFormats]);

    const restoreOrFallbackSelection = useCallback((editor: HTMLDivElement) => {
      const sel = window.getSelection();
      if (!sel) return;
      const saved = savedRangeRef.current;
      if (saved && editor.contains(saved.commonAncestorContainer)) {
        sel.removeAllRanges();
        sel.addRange(saved);
      } else {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }, []);

    const applyFormat = useCallback(
      (formatId: ComposeFormatId) => {
        const editor = editorRef.current;
        if (!editor) return;

        if (document.activeElement !== editor) {
          editor.focus();
          restoreOrFallbackSelection(editor);
        }

        const sel = window.getSelection();
        if (!sel) return;

        if (sel.rangeCount === 0) {
          restoreOrFallbackSelection(editor);
        }

        const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        if (!range || !editor.contains(range.commonAncestorContainer)) {
          restoreOrFallbackSelection(editor);
        }

        if (!sel.rangeCount) return;
        const liveRange = sel.getRangeAt(0);
        const hasSelection = !liveRange.collapsed;
        const isActive = isFormatActiveInRange(liveRange, editor, formatId);

        if (isActive) {
          if (hasSelection) {
            unwrapFormatInRange(liveRange, formatId);
          } else if (!unwrapFormatAtCaret(liveRange, editor, formatId)) {
            switch (formatId) {
              case "underline":
                document.execCommand("underline", false);
                break;
              case "strikethrough":
                document.execCommand("strikeThrough", false);
                break;
              default:
                break;
            }
          }
          sel.removeAllRanges();
          sel.addRange(liveRange);
          syncMarkdownFromEditor();
          publishActiveFormats();
          return;
        }

        switch (formatId) {
          case "bold": {
            if (hasSelection) {
              const el = wrapRangeInSpan(liveRange, { floraBold: "" }, BOLD_STYLE);
              placeCaretAfter(sel, el);
            } else {
              const el = insertPlaceholderSpan(liveRange, { floraBold: "" }, BOLD_STYLE, "текст");
              selectNodeContents(sel, el);
            }
            break;
          }
          case "italic": {
            if (hasSelection) {
              const el = wrapRangeInSpan(liveRange, { floraItalic: "" }, ITALIC_STYLE);
              placeCaretAfter(sel, el);
            } else {
              const el = insertPlaceholderSpan(liveRange, { floraItalic: "" }, ITALIC_STYLE, "текст");
              selectNodeContents(sel, el);
            }
            break;
          }
          case "underline": {
            if (hasSelection) {
              const el = wrapRangeIn(liveRange, "u");
              placeCaretAfter(sel, el);
            } else {
              document.execCommand("underline", false);
            }
            break;
          }
          case "strikethrough": {
            if (hasSelection) {
              const el = wrapRangeIn(liveRange, "s");
              placeCaretAfter(sel, el);
            } else {
              document.execCommand("strikeThrough", false);
            }
            break;
          }
          case "mono": {
            const text = liveRange.toString() || "текст";
            if (hasSelection) {
              const el = wrapRangeIn(liveRange, "code");
              placeCaretAfter(sel, el);
            } else {
              liveRange.deleteContents();
              const code = document.createElement("code");
              code.textContent = text;
              liveRange.insertNode(code);
              selectNodeContents(sel, code);
            }
            break;
          }
          case "spoiler": {
            const text = liveRange.toString() || "спойлер";
            liveRange.deleteContents();
            const span = document.createElement("span");
            span.dataset.floraSpoiler = "";
            span.textContent = text;
            liveRange.insertNode(span);
            if (hasSelection) placeCaretAfter(sel, span);
            else selectNodeContents(sel, span);
            break;
          }
          case "link": {
            const label = liveRange.toString() || "текст";
            liveRange.deleteContents();
            const anchor = document.createElement("a");
            anchor.href = "https://";
            anchor.textContent = label;
            liveRange.insertNode(anchor);
            selectNodeContents(sel, anchor);
            break;
          }
          case "mention": {
            const raw = liveRange.toString().replace(/^@+/, "") || "";
            const token = raw ? `@${raw}` : "@";
            liveRange.deleteContents();
            const mention = document.createElement("span");
            mention.dataset.floraMention = "";
            mention.textContent = token;
            liveRange.insertNode(mention);
            placeCaretAfter(sel, mention);
            break;
          }
          default:
            break;
        }

        syncMarkdownFromEditor();
        publishActiveFormats();
      },
      [syncMarkdownFromEditor, restoreOrFallbackSelection, publishActiveFormats],
    );

    const insertText = useCallback(
      (token: string) => {
        const editor = editorRef.current;
        if (!editor) return;
        if (document.activeElement !== editor) {
          editor.focus();
          restoreOrFallbackSelection(editor);
        }
        document.execCommand("insertText", false, token);
        syncMarkdownFromEditor();
        publishActiveFormats();
      },
      [syncMarkdownFromEditor, restoreOrFallbackSelection, publishActiveFormats],
    );

    useImperativeHandle(
      ref,
      () => ({ focus: () => editorRef.current?.focus(), applyFormat, insertText }),
      [applyFormat, insertText],
    );

    const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      if (text) document.execCommand("insertText", false, text);
      syncMarkdownFromEditor();
      publishActiveFormats();
    };

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        document.execCommand("insertLineBreak");
        syncMarkdownFromEditor();
        publishActiveFormats();
      }
    };

    const handleInput = () => {
      syncMarkdownFromEditor();
      publishActiveFormats();
    };

    return (
      <div
        ref={editorRef}
        className={`${styles.composeRichEditor} flora-type-15`}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        onBlur={saveSelection}
        onInput={handleInput}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
      />
    );
  },
);
