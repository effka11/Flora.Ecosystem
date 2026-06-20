import { forwardRef, type CSSProperties, type ReactNode } from "react";
import styles from "./composeFormattedText.module.css";

export type ComposeFormatFlags = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  mono?: boolean;
  spoiler?: boolean;
};

export type ComposeMirrorSpan = {
  text: string;
  hidden?: boolean;
  formats?: ComposeFormatFlags;
  href?: string;
  mention?: boolean;
};

type DelimitedMatch = {
  kind: "delimited";
  format: keyof ComposeFormatFlags;
  open: string;
  close: string;
  innerStart: number;
  innerEnd: number;
  end: number;
};

type LinkMatch = {
  kind: "link";
  labelStart: number;
  labelEnd: number;
  urlStart: number;
  urlEnd: number;
  end: number;
};

type MentionMatch = {
  kind: "mention";
  start: number;
  end: number;
};

type MirrorMatch = DelimitedMatch | LinkMatch | MentionMatch;

const MENTION_RE = /^@[\w]+/;

function findClosingDelimiter(source: string, from: number, delimiter: string): number {
  return source.indexOf(delimiter, from);
}

function findClosingItalic(source: string, from: number): number {
  for (let i = from; i < source.length; i += 1) {
    if (source[i] !== "*") continue;
    if (source[i - 1] === "*") continue;
    if (source[i + 1] === "*") continue;
    return i;
  }
  return -1;
}

function findMirrorMatch(source: string, index: number): MirrorMatch | null {
  if (source[index] === "[") {
    const closeBracket = source.indexOf("]", index + 1);
    if (closeBracket > index && source[closeBracket + 1] === "(") {
      const closeParen = source.indexOf(")", closeBracket + 2);
      if (closeParen > closeBracket) {
        return {
          kind: "link",
          labelStart: index + 1,
          labelEnd: closeBracket,
          urlStart: closeBracket + 2,
          urlEnd: closeParen,
          end: closeParen + 1,
        };
      }
    }
  }

  if (source.startsWith("**", index)) {
    const close = findClosingDelimiter(source, index + 2, "**");
    if (close > index + 2) {
      return {
        kind: "delimited",
        format: "bold",
        open: "**",
        close: "**",
        innerStart: index + 2,
        innerEnd: close,
        end: close + 2,
      };
    }
  }

  if (source.startsWith("__", index)) {
    const close = findClosingDelimiter(source, index + 2, "__");
    if (close > index + 2) {
      return {
        kind: "delimited",
        format: "underline",
        open: "__",
        close: "__",
        innerStart: index + 2,
        innerEnd: close,
        end: close + 2,
      };
    }
  }

  if (source.startsWith("~~", index)) {
    const close = findClosingDelimiter(source, index + 2, "~~");
    if (close > index + 2) {
      return {
        kind: "delimited",
        format: "strikethrough",
        open: "~~",
        close: "~~",
        innerStart: index + 2,
        innerEnd: close,
        end: close + 2,
      };
    }
  }

  if (source.startsWith("||", index)) {
    const close = findClosingDelimiter(source, index + 2, "||");
    if (close > index + 2) {
      return {
        kind: "delimited",
        format: "spoiler",
        open: "||",
        close: "||",
        innerStart: index + 2,
        innerEnd: close,
        end: close + 2,
      };
    }
  }

  if (source[index] === "`") {
    const close = source.indexOf("`", index + 1);
    if (close > index + 1) {
      return {
        kind: "delimited",
        format: "mono",
        open: "`",
        close: "`",
        innerStart: index + 1,
        innerEnd: close,
        end: close + 1,
      };
    }
  }

  if (source[index] === "*" && source[index + 1] !== "*") {
    const close = findClosingItalic(source, index + 1);
    if (close > index + 1) {
      return {
        kind: "delimited",
        format: "italic",
        open: "*",
        close: "*",
        innerStart: index + 1,
        innerEnd: close,
        end: close + 1,
      };
    }
  }

  const mention = source.slice(index).match(MENTION_RE);
  if (mention && mention.index === 0) {
    return {
      kind: "mention",
      start: index,
      end: index + mention[0].length,
    };
  }

  return null;
}

export function parseComposeMirrorSpans(source: string, inherited: ComposeFormatFlags = {}): ComposeMirrorSpan[] {
  const spans: ComposeMirrorSpan[] = [];
  let index = 0;

  while (index < source.length) {
    const match = findMirrorMatch(source, index);
    if (!match) {
      let next = index + 1;
      while (next < source.length && !findMirrorMatch(source, next)) next += 1;
      spans.push({ text: source.slice(index, next), formats: inherited });
      index = next;
      continue;
    }

    if (match.kind === "mention") {
      spans.push({
        text: source.slice(match.start, match.end),
        formats: inherited,
        mention: true,
      });
      index = match.end;
      continue;
    }

    if (match.kind === "link") {
      const href = source.slice(match.urlStart, match.urlEnd);
      spans.push({ text: "[", hidden: true });
      for (const inner of parseComposeMirrorSpans(source.slice(match.labelStart, match.labelEnd), inherited)) {
        spans.push(inner.hidden ? inner : { ...inner, href });
      }
      spans.push({ text: "]", hidden: true });
      spans.push({ text: "(", hidden: true });
      spans.push({ text: href, hidden: true });
      spans.push({ text: ")", hidden: true });
      index = match.end;
      continue;
    }

    spans.push({ text: match.open, hidden: true });
    spans.push(
      ...parseComposeMirrorSpans(source.slice(match.innerStart, match.innerEnd), {
        ...inherited,
        [match.format]: true,
      }),
    );
    spans.push({ text: match.close, hidden: true });
    index = match.end;
  }

  return spans;
}

function spanClassName(span: ComposeMirrorSpan): string {
  const classes = [styles.span];
  const formats = span.formats ?? {};
  if (formats.bold) classes.push(styles.bold);
  if (formats.italic) classes.push(styles.italic);
  if (formats.underline) classes.push(styles.underline);
  if (formats.strikethrough) classes.push(styles.strikethrough);
  if (formats.mono) classes.push(styles.mono);
  if (formats.spoiler) classes.push(styles.spoiler);
  if (span.href) classes.push(styles.link);
  if (span.mention) classes.push(styles.mention);
  if (span.hidden) classes.push(styles.hiddenMarker);
  return classes.join(" ");
}

function renderMirrorSpan(span: ComposeMirrorSpan, key: string): ReactNode {
  if (span.href && !span.hidden) {
    return (
      <span key={key} className={spanClassName(span)}>
        {span.text}
      </span>
    );
  }

  return (
    <span key={key} className={spanClassName(span)}>
      {span.text}
    </span>
  );
}

type ComposeFormattedMirrorProps = {
  text: string;
  className?: string;
  style?: CSSProperties;
};

export const ComposeFormattedMirror = forwardRef<HTMLDivElement, ComposeFormattedMirrorProps>(
  function ComposeFormattedMirror({ text, className, style }, ref) {
    const spans = parseComposeMirrorSpans(text);
    return (
      <div ref={ref} className={className} style={style} aria-hidden>
        {spans.map((span, index) => renderMirrorSpan(span, `${index}-${span.text}`))}
      </div>
    );
  },
);

type ComposeFormattedContentProps = {
  text: string;
  className?: string;
};

export function ComposeFormattedContent({ text, className }: ComposeFormattedContentProps) {
  const spans = parseComposeMirrorSpans(text).filter((span) => !span.hidden);
  if (spans.length === 0) return null;

  return (
    <span className={className}>
      {spans.map((span, index) => {
        if (span.href) {
          return (
            <a
              key={`${index}-${span.text}`}
              href={span.href}
              className={spanClassName(span)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {span.text}
            </a>
          );
        }
        return renderMirrorSpan(span, `${index}-${span.text}`);
      })}
    </span>
  );
}
