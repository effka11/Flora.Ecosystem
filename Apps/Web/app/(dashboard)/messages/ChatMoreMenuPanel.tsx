"use client";

import type { ReactNode, RefObject } from "react";
import rectStyles from "@/app/_shared/FloraRectMenu.module.css";

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

function IconSearch() {
  return (
    <svg {...menuIconProps}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </svg>
  );
}

function IconMedia() {
  return (
    <svg {...menuIconProps}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 15l5-4 4 3 3-2 6 5" />
    </svg>
  );
}

function IconPinned() {
  return (
    <svg {...menuIconProps}>
      <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3.5L6 20V5a1 1 0 0 1 1-1z" />
      <path d="M9 8h6M9 11h4" />
    </svg>
  );
}

function IconMute() {
  return (
    <svg {...menuIconProps}>
      <path d="M11 5L6 9H3v6h3l5 4V5z" />
      <path d="M16 9l5 5M21 9l-5 5" />
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

type ChatMoreMenuPanelProps = {
  firstActionRef: RefObject<HTMLButtonElement | null>;
  onAction: () => void;
  onSearch?: () => void;
  onMedia?: () => void;
  onPin?: () => void;
  onDelete?: () => void;
  muteSubmenuOpen: boolean;
  isSubmenuClosing: boolean;
  onToggleMuteSubmenu: () => void;
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

export function ChatMoreMenuPanel({
  firstActionRef,
  onAction,
  onSearch,
  onMedia,
  onPin,
  onDelete,
  muteSubmenuOpen,
  isSubmenuClosing,
  onToggleMuteSubmenu,
}: ChatMoreMenuPanelProps) {
  const submenuExpanded = muteSubmenuOpen && !isSubmenuClosing;

  return (
    <>
      <MenuRow
        icon={<IconSearch />}
        label="Поиск"
        onClick={() => {
          onSearch?.();
          onAction();
        }}
      />
      <MenuRow
        icon={<IconMedia />}
        label="Медиа"
        onClick={() => {
          onMedia?.();
          onAction();
        }}
      />
      <MenuRow
        icon={<IconPinned />}
        label="Закреплённое"
        onClick={() => {
          onPin?.();
          onAction();
        }}
      />
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
      <MenuRow
        icon={<IconDelete />}
        label="Удалить чат"
        danger
        onClick={() => {
          onDelete?.();
          onAction();
        }}
      />
    </>
  );
}
