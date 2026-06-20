"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ComposeFormattedContent } from "./composeFormattedText";
import styles from "./ExpandablePostText.module.css";

type ExpandablePostTextProps = {
  text: string;
  hasMedia?: boolean;
  className?: string;
};

const TEXT_ONLY_LINES = 8;
const WITH_MEDIA_LINES = 4;

type ClampStyle = CSSProperties & {
  "--flora-post-text-lines": number;
};

export function ExpandablePostText({ text, hasMedia = false, className }: ExpandablePostTextProps) {
  const contentRef = useRef<HTMLParagraphElement | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [canExpand, setCanExpand] = useState(false);
  const collapsedLines = hasMedia ? WITH_MEDIA_LINES : TEXT_ONLY_LINES;
  const textKey = `${collapsedLines}:${text}`;
  const expanded = expandedKey === textKey;

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;

    const measure = () => {
      const computed = window.getComputedStyle(node);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      const fallbackLineHeight = Number.parseFloat(computed.fontSize) * 1.7;
      const oneLine = Number.isFinite(lineHeight) ? lineHeight : fallbackLineHeight;
      const collapsedHeight = oneLine * collapsedLines;
      setCanExpand(node.scrollHeight > collapsedHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, collapsedLines]);

  const rootClassName = [
    styles.root,
    expanded ? styles.rootExpanded : "",
    canExpand ? styles.rootExpandable : "",
  ]
    .filter(Boolean)
    .join(" ");
  const contentClassName = [className, styles.content].filter(Boolean).join(" ");
  const contentStyle: ClampStyle = { "--flora-post-text-lines": collapsedLines, margin: 0 };

  return (
    <div className={rootClassName}>
      <p ref={contentRef} className={contentClassName} style={contentStyle}>
        <ComposeFormattedContent text={text} />
      </p>
      {canExpand && !expanded ? <div className={styles.fade} aria-hidden /> : null}
      {canExpand ? (
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setExpandedKey((value) => (value === textKey ? null : textKey))}
        >
          {expanded ? "Свернуть" : "Показать полностью"}
        </button>
      ) : null}
    </div>
  );
}
