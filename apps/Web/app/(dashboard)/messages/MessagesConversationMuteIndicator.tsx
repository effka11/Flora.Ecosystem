"use client";

import { useEffect, useState } from "react";
import { FloraHoverTooltip } from "@/app/_shared/FloraHoverTooltip";
import {
  formatConversationMuteTooltip,
  isConversationMuteActive,
  type ConversationMuteEntry,
} from "./conversationMute";
import { MessagesConversationMuteIcon } from "./MessagesConversationMuteIcon";
import styles from "./messages.module.css";

type MessagesConversationMuteIndicatorProps = {
  mute: ConversationMuteEntry;
  className?: string;
  onExpired?: () => void;
};

export function MessagesConversationMuteIndicator({
  mute,
  className,
  onExpired,
}: MessagesConversationMuteIndicatorProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (mute.kind === "forever") return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [mute.kind, mute.kind === "until" ? mute.untilMs : 0]);

  useEffect(() => {
    if (mute.kind !== "until" || mute.untilMs > nowMs) return;
    onExpired?.();
  }, [mute, nowMs, onExpired]);

  if (!isConversationMuteActive(mute, nowMs)) return null;

  const tooltipLabel = formatConversationMuteTooltip(mute, nowMs);

  return (
    <FloraHoverTooltip
      label={tooltipLabel}
      className={className ?? styles.messagesConversationMuteIcon}
      ariaLabel={`Уведомления заглушены: ${tooltipLabel}`}
    >
      <MessagesConversationMuteIcon />
    </FloraHoverTooltip>
  );
}
