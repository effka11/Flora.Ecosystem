"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  bubbleInnerMaxWidthPx,
  resolveBubbleTimePlacement,
  splitBubbleTextLines,
  type BubbleTimePlacement,
} from "./messageBubbleTextLines";
import styles from "./messages.module.css";

type MessageBubbleTextProps = {
  body: string;
  inlineTime: boolean;
  timeLabel: string;
  timeMeta?: ReactNode;
  timeInlineReservePx?: number;
};

export function MessageBubbleText({
  body,
  inlineTime,
  timeLabel,
  timeMeta,
  timeInlineReservePx = 0,
}: MessageBubbleTextProps) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [placement, setPlacement] = useState<BubbleTimePlacement>("inline");

  useLayoutEffect(() => {
    if (!inlineTime) {
      return;
    }

    const bubble = textRef.current?.closest(`.${styles.messagesBubble}`);
    if (!(bubble instanceof HTMLElement)) {
      return;
    }

    const textFont = window.getComputedStyle(bubble).font;
    const timeEl = textRef.current?.querySelector(`.${styles.messagesBubbleTime}`);
    const timeFont =
      timeEl instanceof HTMLElement ? window.getComputedStyle(timeEl).font : textFont;
    const maxWidthPx = bubbleInnerMaxWidthPx(bubble);

    const lines = body.includes("\n")
      ? body.split("\n")
      : splitBubbleTextLines(body, maxWidthPx, textFont);

    setPlacement(resolveBubbleTimePlacement(lines, textFont, timeFont, timeLabel, maxWidthPx, timeInlineReservePx));
  }, [body, inlineTime, timeLabel, timeInlineReservePx]);

  if (!inlineTime) {
    return <p className={styles.messagesBubbleText}>{body}</p>;
  }

  return (
    <p ref={textRef} className={styles.messagesBubbleText}>
      {body}
      <span
        className={`${styles.messagesBubbleTime} ${placement === "inline" ? styles.messagesBubbleTimeFloat : styles.messagesBubbleTimeBelowRow}`}
      >
        {timeLabel}
        {timeMeta}
      </span>
    </p>
  );
}
