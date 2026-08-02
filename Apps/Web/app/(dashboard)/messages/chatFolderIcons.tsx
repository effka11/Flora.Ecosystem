/**
 * Иконки папок чатов — паритет с Mobile Ionicons (эталон CreateChatFolderSheet).
 * Имена на wire/API = ionicon glyph names (`folder-outline`, …).
 */
import type { ReactNode } from "react";

const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24" as const,
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

/** Тот же порядок/набор, что `FOLDER_ICONS` на Mobile. */
export const CHAT_FOLDER_ICON_NAMES = [
  "folder-outline",
  "briefcase-outline",
  "heart-outline",
  "star-outline",
  "flash-outline",
  "home-outline",
  "game-controller-outline",
  "musical-notes-outline",
  "airplane-outline",
  "cafe-outline",
  "book-outline",
  "construct-outline",
] as const;

export type ChatFolderIconName = (typeof CHAT_FOLDER_ICON_NAMES)[number];

const KNOWN = new Set<string>(CHAT_FOLDER_ICON_NAMES);

export function isChatFolderIconName(value: string): value is ChatFolderIconName {
  return KNOWN.has(value);
}

function Svg({ children }: { children: ReactNode }) {
  return <svg {...iconProps}>{children}</svg>;
}

const ICONS: Record<string, () => ReactNode> = {
  "folder-outline": () => (
    <Svg>
      <path d="M3 7a2 2 0 012-2h5l2 2h9a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </Svg>
  ),
  "briefcase-outline": () => (
    <Svg>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 12h18" />
    </Svg>
  ),
  "heart-outline": () => (
    <Svg>
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z" />
    </Svg>
  ),
  "star-outline": () => (
    <Svg>
      <path d="M12 2l2.9 6.26L22 9.27l-5 4.87L18.2 22 12 18.56 5.8 22 7 14.14l-5-4.87 7.1-1.01L12 2z" />
    </Svg>
  ),
  "flash-outline": () => (
    <Svg>
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </Svg>
  ),
  "home-outline": () => (
    <Svg>
      <path d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1v-9.5z" />
    </Svg>
  ),
  "game-controller-outline": () => (
    <Svg>
      <path d="M6 10h12a4 4 0 014 4v2a4 4 0 01-4 4H6a4 4 0 01-4-4v-2a4 4 0 014-4z" />
      <path d="M8 14h2M9 13v2M15.5 13.5h.01M17.5 15.5h.01" />
    </Svg>
  ),
  "musical-notes-outline": () => (
    <Svg>
      <path d="M9 18V6l10-2v12" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="16" r="2" />
    </Svg>
  ),
  "airplane-outline": () => (
    <Svg>
      <path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0010.5 2 1.5 1.5 0 009 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
    </Svg>
  ),
  "cafe-outline": () => (
    <Svg>
      <path d="M4 9h12v5a4 4 0 01-4 4H8a4 4 0 01-4-4V9z" />
      <path d="M16 10h1a3 3 0 010 6h-1M6 20h10" />
    </Svg>
  ),
  "book-outline": () => (
    <Svg>
      <path d="M4 5a2 2 0 012-2h11v16H6a2 2 0 00-2 2V5z" />
      <path d="M6 3v16" />
    </Svg>
  ),
  "construct-outline": () => (
    <Svg>
      <path d="M14.7 6.3a4 4 0 015 5l-7.1 7.1a2 2 0 01-2.8 0L6.3 14.7a2 2 0 010-2.8l7.1-7.1z" />
      <path d="M11 13l-8 8M16.5 7.5l1 1" />
    </Svg>
  ),
  "archive-outline": () => (
    <Svg>
      <path d="M4 7h16v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7z" />
      <path d="M8 3h8v4H8V3zM10 12h4" />
    </Svg>
  ),
  "people-outline": () => (
    <Svg>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </Svg>
  ),
};

export function renderChatFolderIcon(name: string | null | undefined): ReactNode {
  const key = name && ICONS[name] ? name : "folder-outline";
  return ICONS[key]!();
}
