"use client";

import composeStyles from "./compose.module.css";

export function ComposeEmojiStickerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden className={composeStyles.composeEmojiStickerIcon}>
      <path
        d="M12 20.2a8.2 8.2 0 1 0 0-16.4 8.2 8.2 0 0 0 0 16.4Z"
        stroke="currentColor"
        strokeWidth="1.55"
      />
      <path
        d="M16.65 17.25c1.04-.24 1.98-.82 2.72-1.65-.42 2.02-1.85 3.46-3.92 3.9.63-.57 1.04-1.35 1.2-2.25Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.25 11.15h.01M15.1 11.15h.01" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M9.4 14.6c1.28 1.1 3.62 1.1 4.9 0" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}
