export type ComposeFormatId =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "mono"
  | "spoiler"
  | "link"
  | "mention";

type FormatSpec = {
  open: string;
  close: string;
};

const FORMAT_SPECS: Record<ComposeFormatId, FormatSpec> = {
  bold: { open: "**", close: "**" },
  italic: { open: "*", close: "*" },
  underline: { open: "__", close: "__" },
  strikethrough: { open: "~~", close: "~~" },
  mono: { open: "`", close: "`" },
  spoiler: { open: "||", close: "||" },
  link: { open: "[", close: "]" },
  mention: { open: "@", close: "" },
};

export type ComposeSelection = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

export function applyComposeFormat(
  draft: ComposeSelection,
  formatId: ComposeFormatId,
): ComposeSelection {
  const { text, selectionStart, selectionEnd } = draft;
  const selected = text.slice(selectionStart, selectionEnd);

  if (formatId === "link") {
    const label = selected || "текст";
    const insertion = `[${label}](https://)`;
    const next = `${text.slice(0, selectionStart)}${insertion}${text.slice(selectionEnd)}`;
    const urlStart = selectionStart + label.length + 3;
    const urlEnd = urlStart + "https://".length;
    return { text: next, selectionStart: urlStart, selectionEnd: urlEnd };
  }

  if (formatId === "mention") {
    const handle = selected.replace(/^@+/, "") || "";
    const insertion = handle ? `@${handle}` : "@";
    const next = `${text.slice(0, selectionStart)}${insertion}${text.slice(selectionEnd)}`;
    const caret = selectionStart + insertion.length;
    return { text: next, selectionStart: caret, selectionEnd: caret };
  }

  const { open, close } = FORMAT_SPECS[formatId];
  if (selected) {
    const insertion = `${open}${selected}${close}`;
    const next = `${text.slice(0, selectionStart)}${insertion}${text.slice(selectionEnd)}`;
    return {
      text: next,
      selectionStart: selectionStart + open.length,
      selectionEnd: selectionStart + open.length + selected.length,
    };
  }

  const insertion = `${open}${close}`;
  const next = `${text.slice(0, selectionStart)}${insertion}${text.slice(selectionEnd)}`;
  const caret = selectionStart + open.length;
  return { text: next, selectionStart: caret, selectionEnd: caret };
}
