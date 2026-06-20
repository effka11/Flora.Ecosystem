"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  MessageEmojiPicker,
  MessageEmojiPickerGrid,
  MessageEmojiPickerRail,
} from "@/app/(dashboard)/messages/MessageEmojiPicker";
import { MESSAGE_EMOJI_CATEGORY_COUNT } from "@/app/(dashboard)/messages/messageEmojiLayout";
import styles from "./messages.module.css";

const FLORA_GITHUB_URL = "https://github.com/effka11/Flora.Ecosystem";

export type StickerPanelTab = "emoji" | "stickers";
export type StickerTabTransition = null | "toEmoji" | "toStickers";

type MessageStickerPanelProps = {
  panelId: string;
  active: boolean;
  closing: boolean;
  layoutMotion: boolean;
  tab: StickerPanelTab;
  tabTransition: StickerTabTransition;
  tabAnimEpoch: number;
  onPickEmoji: (emoji: string) => void;
  onSelectTab: (tab: StickerPanelTab) => void;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  panelAttr?: string;
  panelLifted?: boolean;
};

export function MessageStickerPanelAnchor({ children }: { children: ReactNode }) {
  return <div className={styles.messagesComposePanelAnchor}>{children}</div>;
}

export function MessageStickerPanel({
  panelId,
  active,
  closing,
  layoutMotion,
  tab,
  tabTransition,
  tabAnimEpoch,
  onPickEmoji,
  onSelectTab,
  panelClassName = "",
  panelStyle,
  panelAttr,
  panelLifted = false,
}: MessageStickerPanelProps) {
  const tabPanelAnimClassName =
    tabTransition === "toEmoji"
      ? `${styles.messagesStickerTabPanelAnim} ${styles.messagesStickerTabPanelToEmoji}`
      : tabTransition === "toStickers"
        ? `${styles.messagesStickerTabPanelAnim} ${styles.messagesStickerTabPanelToStickers}`
        : styles.messagesStickerTabPanelAnim;

  return (
    <MessageEmojiPicker active={active}>
      <div
        id={panelId}
        className={`${styles.messagesStickerPanel} ${tab === "emoji" ? styles.messagesStickerPanelWithCategories : ""} ${layoutMotion ? styles.messagesStickerPanelLayoutMotion : ""} ${closing ? styles.messagesStickerPanelClosing : ""} ${panelClassName}`.trim()}
        style={{
          ...(tab === "emoji"
            ? ({ "--messages-emoji-category-count": MESSAGE_EMOJI_CATEGORY_COUNT } as CSSProperties)
            : {}),
          ...panelStyle,
        }}
        role="dialog"
        aria-label="Стикеры и эмодзи"
        {...(panelAttr ? { [panelAttr]: "" } : {})}
        {...(panelLifted ? { "data-compose-popover-lifted": "" } : {})}
      >
        <MessageEmojiPickerRail collapsed={tab !== "emoji"} />
        <div className={styles.messagesStickerPanelBody}>
          <div
            className={styles.messagesStickerTabs}
            role="tablist"
            aria-label="Раздел панели"
            data-active-tab={tab}
          >
            <span className={styles.messagesStickerTabIndicator} aria-hidden />
            <button
              type="button"
              role="tab"
              id={`${panelId}-tab-emoji`}
              className={styles.messagesStickerTab}
              aria-selected={tab === "emoji"}
              aria-controls={`${panelId}-emoji`}
              onClick={() => onSelectTab("emoji")}
            >
              Эмодзи
            </button>
            <button
              type="button"
              role="tab"
              id={`${panelId}-tab-stickers`}
              className={styles.messagesStickerTab}
              aria-selected={tab === "stickers"}
              aria-controls={`${panelId}-stickers`}
              onClick={() => onSelectTab("stickers")}
            >
              Стикеры
            </button>
          </div>
          {tab === "emoji" ? (
            <MessageEmojiPickerGrid
              key={`emoji-${tabAnimEpoch}`}
              onPick={onPickEmoji}
              panelClassName={tabPanelAnimClassName}
            />
          ) : (
            <div
              key={`stickers-${tabAnimEpoch}`}
              id={`${panelId}-stickers`}
              role="tabpanel"
              className={tabPanelAnimClassName}
              aria-labelledby={`${panelId}-tab-stickers`}
            >
              <p className={styles.messagesStickersPlaceholder}>
                Стикеры еще в разработке. Следите за обновлениями и принимайте участие в разработке некоммерческой
                экосистемы FLORA на{" "}
                <a
                  className={styles.messagesStickersPlaceholderLink}
                  href={FLORA_GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
              </p>
            </div>
          )}
        </div>
      </div>
    </MessageEmojiPicker>
  );
}
