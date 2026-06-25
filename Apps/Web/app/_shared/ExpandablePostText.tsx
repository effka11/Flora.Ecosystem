"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ComposeFormattedContent } from "./composeFormattedText";
import styles from "./ExpandablePostText.module.css";

type ExpandablePostTextProps = {
  text: string;
  hasMedia?: boolean;
  className?: string;
};

const COLLAPSED_TEXT_LINES = 8;
const COLLAPSED_WITH_MEDIA_LINES = 4;
const EXPAND_CHUNK_TEXT_LINES = 15;
const EXPAND_CHUNK_WITH_MEDIA_LINES = 15;
const LAST_PART_EXTRA_LINES = 5;

type TextMetrics = {
  lineHeightPx: number;
  totalLines: number;
  fullHeightPx: number;
};

function getLineHeight(node: HTMLElement): number {
  const computed = window.getComputedStyle(node);
  const lineHeight = Number.parseFloat(computed.lineHeight);
  const fallbackLineHeight = Number.parseFloat(computed.fontSize) * 1.7;
  return Number.isFinite(lineHeight) ? lineHeight : fallbackLineHeight;
}

function measureText(node: HTMLElement): TextMetrics {
  const lineHeightPx = getLineHeight(node);
  const totalLines = Math.max(1, Math.ceil((node.scrollHeight - 1) / lineHeightPx));
  return {
    lineHeightPx,
    totalLines,
    fullHeightPx: node.scrollHeight,
  };
}

function nextVisibleLines(current: number, total: number, chunk: number): number {
  const remaining = total - current;

  if (remaining <= chunk) {
    return total;
  }

  if (remaining - chunk < LAST_PART_EXTRA_LINES) {
    return Math.min(total, current + chunk + LAST_PART_EXTRA_LINES);
  }

  return current + chunk;
}

function clampHeightPx(metrics: TextMetrics, visibleLines: number, fullyExpanded: boolean): number {
  if (fullyExpanded) {
    return metrics.fullHeightPx;
  }

  return Math.min(metrics.fullHeightPx, visibleLines * metrics.lineHeightPx);
}

export function ExpandablePostText({ text, hasMedia = false, className }: ExpandablePostTextProps) {
  const contentRef = useRef<HTMLParagraphElement | null>(null);
  const collapsedLines = hasMedia ? COLLAPSED_WITH_MEDIA_LINES : COLLAPSED_TEXT_LINES;
  const expandChunkLines = hasMedia ? EXPAND_CHUNK_WITH_MEDIA_LINES : EXPAND_CHUNK_TEXT_LINES;
  const [visibleLines, setVisibleLines] = useState(collapsedLines);
  const [metrics, setMetrics] = useState<TextMetrics | null>(null);

  useEffect(() => {
    setVisibleLines(collapsedLines);
  }, [text, collapsedLines]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;

    const updateMetrics = () => {
      setMetrics(measureText(node));
    };

    updateMetrics();
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, collapsedLines]);

  const totalLines = metrics?.totalLines ?? collapsedLines;
  const fullyExpanded = visibleLines >= totalLines;
  const canExpand = totalLines > collapsedLines;

  const handleToggle = useCallback(() => {
    if (fullyExpanded) {
      setVisibleLines(collapsedLines);
      return;
    }

    setVisibleLines((current) => nextVisibleLines(current, totalLines, expandChunkLines));
  }, [collapsedLines, expandChunkLines, fullyExpanded, totalLines]);

  const contentClassName = [className, styles.content].filter(Boolean).join(" ");
  const clipClassName = [styles.contentClip, canExpand ? styles.contentClipExpandable : ""]
    .filter(Boolean)
    .join(" ");
  const maxHeightPx =
    metrics && canExpand ? clampHeightPx(metrics, visibleLines, fullyExpanded) : undefined;

  return (
    <div className={styles.root}>
      <div className={styles.clipWrap}>
        <div className={clipClassName} style={maxHeightPx === undefined ? undefined : { maxHeight: maxHeightPx }}>
          <p ref={contentRef} className={contentClassName} style={{ margin: 0 }}>
            <ComposeFormattedContent text={text} />
          </p>
        </div>
        {canExpand ? (
          <div className={[styles.fade, fullyExpanded ? styles.fadeHidden : ""].filter(Boolean).join(" ")} aria-hidden />
        ) : null}
      </div>
      {canExpand ? (
        <button type="button" className={styles.toggle} onClick={handleToggle}>
          {fullyExpanded ? "Свернуть" : "Показать полностью"}
        </button>
      ) : null}
    </div>
  );
}
