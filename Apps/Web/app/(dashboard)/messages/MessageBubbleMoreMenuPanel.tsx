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

function IconReply() {
  return (
    <svg {...menuIconProps}>
      <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg {...menuIconProps}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function IconForward() {
  return (
    <svg {...menuIconProps}>
      <path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z" />
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

function IconEdit() {
  return (
    <svg {...menuIconProps}>
      <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />
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

type MenuRowProps = {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
};

function MenuRow({ icon, label, onClick, danger = false, buttonRef }: MenuRowProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`${rectStyles.menuItem} ${danger ? rectStyles.menuItemDanger : ""}`}
      onClick={onClick}
    >
      <span className={rectStyles.menuItemIcon}>{icon}</span>
      <span className={rectStyles.menuItemLabel}>{label}</span>
    </button>
  );
}

export type MessageBubbleMoreMenuPanelProps = {
  isFromMe: boolean;
  firstActionRef: RefObject<HTMLButtonElement | null>;
  onAction: () => void;
  onReply?: () => void;
  onCopy?: () => void;
  onForward?: () => void;
  onPin?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
};

export function MessageBubbleMoreMenuPanel({
  isFromMe,
  firstActionRef,
  onAction,
  onReply,
  onCopy,
  onForward,
  onPin,
  onEdit,
  onDelete,
}: MessageBubbleMoreMenuPanelProps) {
  const pick = (handler?: () => void) => () => {
    handler?.();
    onAction();
  };

  return (
    <>
      <MenuRow
        buttonRef={firstActionRef}
        icon={<IconReply />}
        label="Ответить"
        onClick={pick(onReply)}
      />
      <MenuRow icon={<IconCopy />} label="Копировать" onClick={pick(onCopy)} />
      <MenuRow icon={<IconForward />} label="Переслать" onClick={pick(onForward)} />
      <MenuRow icon={<IconPin />} label="Закрепить" onClick={pick(onPin)} />
      {isFromMe ? <MenuRow icon={<IconEdit />} label="Редактировать" onClick={pick(onEdit)} /> : null}
      {isFromMe ? (
        <MenuRow icon={<IconDelete />} label="Удалить" danger onClick={pick(onDelete)} />
      ) : null}
    </>
  );
}
