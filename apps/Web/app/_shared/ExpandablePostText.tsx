"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
const TRUNCATION_ELLIPSIS = "...";
const CLIP_ANIM_MS = 380;

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

function trimToLastCompleteWord(value: string): string {
  const trimmed = value.trimEnd();
  if (!trimmed) {
    return trimmed;
  }

  const wordBoundary = trimmed.search(/\s+\S*$/);
  return wordBoundary > 0 ? trimmed.slice(0, wordBoundary).trimEnd() : trimmed;
}

function countPlainTextLines(node: HTMLParagraphElement, value: string): number {
  node.textContent = value;
  return measureText(node).totalLines;
}

function truncateTextForVisibleLines(
  text: string,
  measureNode: HTMLParagraphElement,
  maxLines: number,
): string {
  const withEllipsis = (candidate: string) => `${candidate}${TRUNCATION_ELLIPSIS}`;

  if (countPlainTextLines(measureNode, withEllipsis(text)) <= maxLines) {
    return text;
  }

  let low = 0;
  let high = text.length;
  let bestCandidate = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = trimToLastCompleteWord(text.slice(0, mid).trimEnd());
    if (!candidate) {
      high = mid - 1;
      continue;
    }

    if (countPlainTextLines(measureNode, withEllipsis(candidate)) <= maxLines) {
      bestCandidate = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return bestCandidate ? withEllipsis(bestCandidate) : TRUNCATION_ELLIPSIS;
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

export function ExpandablePostText({ text, hasMedia = false, className }: ExpandablePostTextProps) {
  const fullMeasureRef = useRef<HTMLParagraphElement | null>(null);
  const plainMeasureRef = useRef<HTMLParagraphElement | null>(null);
  const displayMeasureRef = useRef<HTMLParagraphElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const animFromHeightRef = useRef<number | null>(null);
  const clipTargetHeightRef = useRef<number | null>(null);
  const collapsedLines = hasMedia ? COLLAPSED_WITH_MEDIA_LINES : COLLAPSED_TEXT_LINES;
  const expandChunkLines = hasMedia ? EXPAND_CHUNK_WITH_MEDIA_LINES : EXPAND_CHUNK_TEXT_LINES;
  const [visibleLines, setVisibleLines] = useState(collapsedLines);
  const [metrics, setMetrics] = useState<TextMetrics | null>(null);
  const [clipMaxHeightPx, setClipMaxHeightPx] = useState<number | undefined>(undefined);
  const [clipHeightPx, setClipHeightPx] = useState<number | undefined>(undefined);
  const [isHeightAnimating, setIsHeightAnimating] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  const contentClassName = [className, styles.content].filter(Boolean).join(" ");
  const measureClassName = [contentClassName, styles.measure].filter(Boolean).join(" ");

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");

    const syncReduceMotion = () => {
      setReduceMotion(media.matches);
    };

    syncReduceMotion();
    media.addEventListener("change", syncReduceMotion);
    return () => media.removeEventListener("change", syncReduceMotion);
  }, []);

  useEffect(() => {
    setVisibleLines(collapsedLines);
  }, [text, collapsedLines]);

  useEffect(() => {
    const node = fullMeasureRef.current;
    if (!node) return;

    const updateMetrics = () => {
      setMetrics(measureText(node));
    };

    updateMetrics();
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, collapsedLines, contentClassName]);

  const totalLines = metrics?.totalLines ?? collapsedLines;
  const fullyExpanded = visibleLines >= totalLines;
  const canExpand = totalLines > collapsedLines;

  const truncatedText = useMemo(() => {
    if (!canExpand || fullyExpanded) {
      return text;
    }

    const measureNode = plainMeasureRef.current;
    if (!measureNode) {
      return text;
    }

    return truncateTextForVisibleLines(text, measureNode, visibleLines);
  }, [canExpand, fullyExpanded, text, visibleLines, metrics, contentClassName]);

  const displayText = fullyExpanded ? text : truncatedText;

  const queueClipAnimationFromCurrent = useCallback(() => {
    const height = clipRef.current?.getBoundingClientRect().height;
    if (height && height > 0) {
      animFromHeightRef.current = height;
    }
  }, []);

  const settleClipHeight = useCallback(() => {
    const targetHeight = clipTargetHeightRef.current;
    setIsHeightAnimating(false);
    setClipHeightPx(undefined);
    if (targetHeight !== null) {
      setClipMaxHeightPx(targetHeight);
    }
  }, []);

  const handleClipTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.propertyName !== "height" || !isHeightAnimating) {
        return;
      }

      settleClipHeight();
    },
    [isHeightAnimating, settleClipHeight],
  );

  const handleToggle = useCallback(() => {
    queueClipAnimationFromCurrent();

    if (fullyExpanded) {
      setVisibleLines(collapsedLines);
      return;
    }

    setVisibleLines((current) => nextVisibleLines(current, totalLines, expandChunkLines));
  }, [collapsedLines, expandChunkLines, fullyExpanded, queueClipAnimationFromCurrent, totalLines]);

  useLayoutEffect(() => {
    const measureNode = displayMeasureRef.current;
    if (!measureNode || !metrics || !canExpand) {
      return;
    }

    const targetHeight = fullyExpanded
      ? metrics.fullHeightPx
      : measureText(measureNode).fullHeightPx;
    const fromHeight = animFromHeightRef.current;

    clipTargetHeightRef.current = targetHeight;

    if (!reduceMotion && fromHeight !== null && Math.abs(fromHeight - targetHeight) > 1) {
      animFromHeightRef.current = null;
      setIsHeightAnimating(true);
      setClipMaxHeightPx(undefined);
      setClipHeightPx(fromHeight);

      const frameId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setClipHeightPx(targetHeight);
        });
      });

      const fallbackTimerId = window.setTimeout(() => {
        settleClipHeight();
      }, CLIP_ANIM_MS + 40);

      return () => {
        cancelAnimationFrame(frameId);
        window.clearTimeout(fallbackTimerId);
      };
    }

    animFromHeightRef.current = null;
    setIsHeightAnimating(false);
    setClipHeightPx(undefined);
    setClipMaxHeightPx(targetHeight);
  }, [canExpand, contentClassName, displayText, fullyExpanded, metrics, reduceMotion, settleClipHeight, visibleLines]);

  const clipClassName = [
    styles.contentClip,
    canExpand ? styles.contentClipExpandable : "",
    isHeightAnimating ? styles.contentClipHeightAnimating : "",
  ]
    .filter(Boolean)
    .join(" ");

  const clipStyle = isHeightAnimating
    ? clipHeightPx === undefined
      ? undefined
      : { height: clipHeightPx, maxHeight: "none" as const }
    : clipMaxHeightPx === undefined
      ? undefined
      : { maxHeight: clipMaxHeightPx };

  if (text.trim().length === 0) {
    return null;
  }

  return (
    <div className={styles.root}>
      <div className={styles.clipWrap}>
        <p ref={fullMeasureRef} className={measureClassName} aria-hidden>
          <ComposeFormattedContent text={text} />
        </p>
        <p ref={plainMeasureRef} className={measureClassName} aria-hidden />
        <p ref={displayMeasureRef} className={measureClassName} aria-hidden>
          <ComposeFormattedContent text={displayText} />
        </p>
        <div
          ref={clipRef}
          className={clipClassName}
          style={clipStyle}
          onTransitionEnd={handleClipTransitionEnd}
        >
          <p className={contentClassName} style={{ margin: 0 }}>
            <ComposeFormattedContent text={displayText} />
          </p>
        </div>
      </div>
      {canExpand ? (
        <button type="button" className={styles.toggle} onClick={handleToggle}>
          {fullyExpanded ? "Свернуть" : "Показать полностью"}
        </button>
      ) : null}
    </div>
  );
}
