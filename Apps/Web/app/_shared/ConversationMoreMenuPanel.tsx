"use client";

import type { ReactNode, RefObject } from "react";
import rectStyles from "./FloraRectMenu.module.css";

const menuIconProps = {
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

function IconMute() {
  return (
    <svg {...menuIconProps}>
      <path d="M11 5L6 9H3v6h3l5 4V5z" />
      <path d="M16 9l5 5M21 9l-5 5" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg {...menuIconProps}>
      <path d="M12 17v5M9 3h6l1 7h4l-7 7-7-7h4l1-7z" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg {...menuIconProps}>
      <path d="M3 7a2 2 0 012-2h5l2 2h9a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  );
}

function IconArchive() {
  return (
    <svg {...menuIconProps}>
      <path d="M4 7h16v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7z" />
      <path d="M8 3h8v4H8V3zM10 12h4" />
    </svg>
  );
}

function IconDelete() {
  return (
    <svg {...menuIconProps}>
      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M10 11v6M14 11v6" />
      <path d="M7 7l1 12a1 1 0 001 1h6a1 1 0 001-1l1-12" />
    </svg>
  );
}

type ConversationMoreMenuPanelProps = {
  firstActionRef: RefObject<HTMLButtonElement | null>;
  onAction: () => void;
  muteSubmenuOpen: boolean;
  isSubmenuClosing: boolean;
  onToggleMuteSubmenu: () => void;
  conversationIsArchived?: boolean;
  onConversationArchive?: () => void;
  onConversationUnarchive?: () => void;
};

function MenuRow({
  icon,
  label,
  onClick,
  danger = false,
  chevron = false,
  buttonRef,
  hasPopup,
  submenuOpen,
  active,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  chevron?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  hasPopup?: boolean;
  submenuOpen?: boolean;
  active?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`${rectStyles.menuItem} ${danger ? rectStyles.menuItemDanger : ""} ${active ? rectStyles.menuItemSubmenuTriggerOpen : ""}`}
      onClick={onClick}
      aria-haspopup={hasPopup ? "menu" : undefined}
      aria-expanded={hasPopup ? submenuOpen : undefined}
    >
      <span className={rectStyles.menuItemIcon}>{icon}</span>
      <span className={rectStyles.menuItemLabel}>{label}</span>
      {chevron ? <span className={rectStyles.menuItemChevron} aria-hidden>{">"}</span> : null}
    </button>
  );
}

export function ConversationMoreMenuPanel({
  firstActionRef,
  onAction,
  muteSubmenuOpen,
  isSubmenuClosing,
  onToggleMuteSubmenu,
  conversationIsArchived = false,
  onConversationArchive,
  onConversationUnarchive,
}: ConversationMoreMenuPanelProps) {
  const submenuExpanded = muteSubmenuOpen && !isSubmenuClosing;

  return (
    <>
      <div className={rectStyles.menuItemSubmenuWrap}>
        <MenuRow
          buttonRef={firstActionRef}
          icon={<IconMute />}
          label="Заглушить"
          chevron
          hasPopup
          submenuOpen={submenuExpanded}
          active={submenuExpanded}
          onClick={onToggleMuteSubmenu}
        />
      </div>

      <MenuRow icon={<IconPin />} label="Закрепить" onClick={onAction} />
      <MenuRow icon={<IconFolder />} label="Добавить в папку" onClick={onAction} />
      <MenuRow
        icon={<IconArchive />}
        label={conversationIsArchived ? "Разархивировать" : "Архивировать"}
        onClick={() => {
          if (conversationIsArchived) onConversationUnarchive?.();
          else onConversationArchive?.();
          onAction();
        }}
      />
      <MenuRow icon={<IconDelete />} label="Удалить чат" onClick={onAction} danger />
    </>
  );
}
