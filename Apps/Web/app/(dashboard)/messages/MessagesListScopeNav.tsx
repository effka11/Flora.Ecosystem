"use client";

import styles from "./messages.module.css";

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

function IconAllChats() {
  return (
    <svg {...iconProps}>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

function IconArchive() {
  return (
    <svg {...iconProps}>
      <path d="M4 7h16v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7z" />
      <path d="M8 3h8v4H8V3zM10 12h4" />
    </svg>
  );
}

export type MessagesChatListScope = "all" | "archived";

type MessagesListScopeNavProps = {
  scope: MessagesChatListScope;
  onScopeChange: (scope: MessagesChatListScope) => void;
};

export function MessagesListScopeNav({ scope, onScopeChange }: MessagesListScopeNavProps) {
  return (
    <nav className={styles.messagesListScopeNav} aria-label="Списки чатов">
      <button
        type="button"
        className={`${styles.messagesListScopeBtn} ${styles.messagesListScopeBtnArchive} ${
          scope === "archived" ? styles.messagesListScopeBtnActive : ""
        }`}
        onClick={() => onScopeChange("archived")}
        aria-pressed={scope === "archived"}
        title="Архивированные чаты"
      >
        <IconArchive />
        <span className={styles.messagesListScopeBtnLabel}>Архив</span>
      </button>
      <button
        type="button"
        className={`${styles.messagesListScopeBtn} ${styles.messagesListScopeBtnAll} ${
          scope === "all" ? styles.messagesListScopeBtnActive : ""
        }`}
        onClick={() => onScopeChange("all")}
        aria-pressed={scope === "all"}
        title="Все чаты"
      >
        <IconAllChats />
        <span className={styles.messagesListScopeBtnLabel}>Все чаты</span>
      </button>
    </nav>
  );
}
