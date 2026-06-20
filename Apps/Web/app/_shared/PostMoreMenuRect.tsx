"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { floraDurationMs } from "@/lib/floraMotion";
import { ChatMoreMenuPanel } from "@/app/(dashboard)/messages/ChatMoreMenuPanel";
import { ConversationMoreMenuPanel } from "./ConversationMoreMenuPanel";
import {
  FLORA_RECT_MENU_PANEL_ATTR,
  isFloraRectMenuOverlayTarget,
  isFloraRectMenuPanelTarget,
  measureRectMenuPanelPosition,
} from "./floraRectMenuOverlay";
import { useConversationMuteSubmenu } from "./useConversationMuteSubmenu";
import rectStyles from "./FloraRectMenu.module.css";
import triggerStyles from "./PostMoreMenu.module.css";

const CLOSE_ANIM_MS = floraDurationMs(1) + 50;

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

function IconSave() {
  return (
    <svg {...menuIconProps}>
      <path d="M6 3h12a1 1 0 011 1v16.5l-7-4.5-7 4.5V4a1 1 0 011-1z" />
    </svg>
  );
}

function IconShare() {
  return (
    <svg {...menuIconProps}>
      <path d="M4 12v6a2 2 0 002 2h12a2 2 0 002-2v-6M16 6l-4-4-4 4M12 2v14" />
    </svg>
  );
}

function IconNotInterested() {
  return (
    <svg {...menuIconProps}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

function IconHideAuthor() {
  return (
    <svg {...menuIconProps}>
      <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="8.5" cy="7" r="4" fill="none" />
      <path d="M17 8l5 5M22 8l-5 5" />
    </svg>
  );
}

function IconReport() {
  return (
    <svg {...menuIconProps}>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" />
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

function IconSimilar() {
  return (
    <svg {...menuIconProps}>
      <path d="M4 14V10M8 16V8M12 14V6M16 16V8M20 14V10" />
    </svg>
  );
}

function IconPlaylist() {
  return (
    <svg {...menuIconProps}>
      <path d="M21 15V6M18 18V3M12 15V9M9 21V3" />
    </svg>
  );
}

const DEFAULT_A11Y = {
  dialog: "Меню поста",
  triggerOpen: "Меню поста",
  triggerClose: "Закрыть меню поста",
} as const;

const CONVERSATION_A11Y = {
  dialog: "Меню чата",
  triggerOpen: "Меню чата",
  triggerClose: "Закрыть меню чата",
} as const;

const CHAT_A11Y = {
  dialog: "Меню открытого чата",
  triggerOpen: "Меню чата",
  triggerClose: "Закрыть меню чата",
} as const;

export type PostMoreMenuRectProps = {
  wrapClassName: string;
  buttonClassName: string;
  sharePath?: string | null;
  accessibility?: Partial<Record<keyof typeof DEFAULT_A11Y, string>>;
  variant?: "post" | "comment" | "track" | "conversation" | "chat";
  /** Якорь панели относительно ⋮ (лента — сверху справа). */
  panelAnchor?: "top-right" | "bottom-left";
  /** Список чатов: на собеседнике активен мут (для «Размутить»). */
  conversationIsMuted?: boolean;
  onConversationMuteForever?: () => void;
  onConversationMuteTemporary?: () => void;
  onConversationUnmute?: () => void;
  conversationIsArchived?: boolean;
  onConversationArchive?: () => void;
  onConversationUnarchive?: () => void;
  /** Свой пост — показать «Удалить пост». */
  canDeletePost?: boolean;
  onDeletePost?: () => void;
  onChatSearch?: () => void;
  onChatMedia?: () => void;
  onChatPin?: () => void;
  onChatDelete?: () => void;
};

export function PostMoreMenuRect({
  wrapClassName,
  buttonClassName,
  sharePath,
  accessibility,
  variant = "post",
  panelAnchor = "top-right",
  conversationIsMuted = false,
  onConversationMuteForever,
  onConversationMuteTemporary,
  onConversationUnmute,
  conversationIsArchived = false,
  onConversationArchive,
  onConversationUnarchive,
  canDeletePost = false,
  onDeletePost,
  onChatSearch,
  onChatMedia,
  onChatPin,
  onChatDelete,
}: PostMoreMenuRectProps) {
  const a11y = {
    ...(variant === "conversation"
      ? CONVERSATION_A11Y
      : variant === "chat"
        ? CHAT_A11Y
        : DEFAULT_A11Y),
    ...accessibility,
  };
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [panelPos, setPanelPos] = useState<CSSProperties | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  const panelMounted = open || isClosing;

  useEffect(() => {
    setPortalReady(true);
  }, []);

  const updatePanelPosition = useCallback(() => {
    const wrap = wrapRef.current;
    const trigger = triggerRef.current;
    if (!wrap || !trigger) return;
    setPanelPos(measureRectMenuPanelPosition(wrap, trigger, panelAnchor));
  }, [panelAnchor]);

  const anchorClass =
    panelAnchor === "bottom-left"
      ? rectStyles.menuPanelAnchorBottomLeft
      : rectStyles.menuPanelAnchorTopRight;

  const isConversation = variant === "conversation";
  const isChat = variant === "chat";
  const hasMuteSubmenu = isConversation || isChat;
  const resetSubmenuRef = useRef<() => void>(() => {});

  const requestClose = useCallback(() => {
    if (!open || isClosing) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpen(false);
      setIsClosing(false);
      resetSubmenuRef.current();
      return;
    }
    setIsClosing(true);
  }, [open, isClosing]);

  const muteSubmenu = useConversationMuteSubmenu({
    enabled: hasMuteSubmenu,
    triggerRef: firstActionRef,
    menuIsClosing: isClosing,
    conversationIsMuted,
    onSubmenuItemPick: () => requestClose(),
    onConversationMuteForever,
    onConversationMuteTemporary,
    onConversationUnmute,
  });

  resetSubmenuRef.current = muteSubmenu.resetSubmenu;

  useEffect(() => {
    if (!isClosing) return;
    const t = window.setTimeout(() => {
      setOpen(false);
      setIsClosing(false);
    }, CLOSE_ANIM_MS);
    return () => window.clearTimeout(t);
  }, [isClosing]);

  useEffect(() => {
    if (open) return;
    if (muteSubmenu.muteSubmenuOpen || muteSubmenu.isSubmenuClosing) return;
    muteSubmenu.resetSubmenu();
  }, [open, muteSubmenu.muteSubmenuOpen, muteSubmenu.isSubmenuClosing, muteSubmenu.resetSubmenu]);

  useLayoutEffect(() => {
    if (!panelMounted) {
      setPanelPos(null);
      return;
    }
    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [panelMounted, updatePanelPosition]);

  useEffect(() => {
    if (!open || isClosing) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el || el.contains(e.target as Node)) return;
      if (isFloraRectMenuOverlayTarget(e.target)) return;
      if (isFloraRectMenuPanelTarget(e.target)) return;
      requestClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => {
      firstActionRef.current?.focus();
    });
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, isClosing, requestClose]);

  const showCloseGlyph = open && !isClosing;

  const menuPanel =
    panelMounted && panelPos ? (
      <div
        className={`${rectStyles.menuPanel} ${anchorClass} ${rectStyles.menuPanelDetached} ${isClosing ? rectStyles.menuPanelClosing : ""}`}
        style={panelPos}
        role="dialog"
        aria-label={a11y.dialog}
        {...{ [FLORA_RECT_MENU_PANEL_ATTR]: "" }}
      >
        {variant === "conversation" ? (
          <ConversationMoreMenuPanel
            firstActionRef={firstActionRef}
            onAction={requestClose}
            muteSubmenuOpen={muteSubmenu.muteSubmenuOpen}
            isSubmenuClosing={muteSubmenu.isSubmenuClosing}
            onToggleMuteSubmenu={muteSubmenu.toggleMuteSubmenu}
            conversationIsArchived={conversationIsArchived}
            onConversationArchive={onConversationArchive}
            onConversationUnarchive={onConversationUnarchive}
          />
        ) : variant === "chat" ? (
          <ChatMoreMenuPanel
            firstActionRef={firstActionRef}
            onAction={requestClose}
            onSearch={onChatSearch}
            onMedia={onChatMedia}
            onPin={onChatPin}
            onDelete={onChatDelete}
            muteSubmenuOpen={muteSubmenu.muteSubmenuOpen}
            isSubmenuClosing={muteSubmenu.isSubmenuClosing}
            onToggleMuteSubmenu={muteSubmenu.toggleMuteSubmenu}
          />
        ) : (
          <>
            {variant === "track" ? (
              <button
                ref={firstActionRef}
                type="button"
                className={rectStyles.menuItem}
                onClick={() => requestClose()}
              >
                <span className={rectStyles.menuItemIcon}>
                  <IconSimilar />
                </span>
                <span className={rectStyles.menuItemLabel}>Слушать похожие</span>
              </button>
            ) : (
              <button
                ref={firstActionRef}
                type="button"
                className={rectStyles.menuItem}
                onClick={() => requestClose()}
              >
                <span className={rectStyles.menuItemIcon}>
                  <IconSave />
                </span>
                <span className={rectStyles.menuItemLabel}>Сохранить</span>
              </button>
            )}

            {sharePath ? (
              <Link href={sharePath} className={rectStyles.menuItem} onClick={() => requestClose()}>
                <span className={rectStyles.menuItemIcon}>
                  <IconShare />
                </span>
                <span className={rectStyles.menuItemLabel}>Поделиться</span>
              </Link>
            ) : (
              <button type="button" className={rectStyles.menuItem} onClick={() => requestClose()}>
                <span className={rectStyles.menuItemIcon}>
                  <IconShare />
                </span>
                <span className={rectStyles.menuItemLabel}>Поделиться</span>
              </button>
            )}

            {variant === "track" ? (
              <button type="button" className={rectStyles.menuItem} onClick={() => requestClose()}>
                <span className={rectStyles.menuItemIcon}>
                  <IconPlaylist />
                </span>
                <span className={rectStyles.menuItemLabel}>В плейлист</span>
              </button>
            ) : null}

            {variant === "track" || (variant === "post" && !canDeletePost) ? (
              <button type="button" className={rectStyles.menuItem} onClick={() => requestClose()}>
                <span className={rectStyles.menuItemIcon}>
                  <IconNotInterested />
                </span>
                <span className={rectStyles.menuItemLabel}>Не интересно</span>
              </button>
            ) : null}

            {variant === "post" && !canDeletePost ? (
              <button type="button" className={rectStyles.menuItem} onClick={() => requestClose()}>
                <span className={rectStyles.menuItemIcon}>
                  <IconHideAuthor />
                </span>
                <span className={rectStyles.menuItemLabel}>Скрыть автора</span>
              </button>
            ) : null}

            {variant === "post" && canDeletePost && onDeletePost ? (
              <button
                type="button"
                className={`${rectStyles.menuItem} ${rectStyles.menuItemDanger}`}
                onClick={() => {
                  onDeletePost();
                  requestClose();
                }}
              >
                <span className={rectStyles.menuItemIcon}>
                  <IconDelete />
                </span>
                <span className={rectStyles.menuItemLabel}>Удалить пост</span>
              </button>
            ) : null}

            {variant === "post" && canDeletePost ? null : (
              <button type="button" className={rectStyles.menuItem} onClick={() => requestClose()}>
                <span className={rectStyles.menuItemIcon}>
                  <IconReport />
                </span>
                <span className={rectStyles.menuItemLabel}>Пожаловаться</span>
              </button>
            )}
          </>
        )}
      </div>
    ) : null;

  return (
    <div
      ref={wrapRef}
      className={`${wrapClassName} ${open ? rectStyles.wrapOpen : ""}`}
      /* Выше соседних ⋮ в списках (локальные z-index в page CSS перебивают .wrapOpen). */
      style={open || muteSubmenu.muteSubmenuOpen || muteSubmenu.isSubmenuClosing ? { zIndex: 200 } : undefined}
    >
      {hasMuteSubmenu ? muteSubmenu.submenuPortal : null}
      {portalReady && menuPanel ? createPortal(menuPanel, document.body) : null}

      <button
        ref={triggerRef}
        type="button"
        className={`${buttonClassName} ${triggerStyles.triggerLift} ${isChat ? triggerStyles.triggerLiftNoBackdrop : ""} ${open ? triggerStyles.triggerOpen : ""} ${showCloseGlyph && !isChat ? triggerStyles.triggerBackdropVisible : ""}`}
        title={open ? "Закрыть" : "Ещё"}
        aria-label={open ? a11y.triggerClose : a11y.triggerOpen}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (isClosing) return;
          if (open) requestClose();
          else {
            resetSubmenuRef.current();
            setOpen(true);
            setIsClosing(false);
          }
        }}
      >
        <span className={triggerStyles.triggerGlyphStack}>
          <span
            className={`${triggerStyles.triggerGlyph} ${showCloseGlyph ? "" : triggerStyles.triggerGlyphVisible}`}
            aria-hidden
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="12" cy="6" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="18" r="1.5" />
            </svg>
          </span>
          <span
            className={`${triggerStyles.triggerGlyph} ${showCloseGlyph ? triggerStyles.triggerGlyphVisible : ""}`}
            aria-hidden
          >
            <span className={triggerStyles.triggerCloseWrap}>
              <svg
                width="10"
                height="10"
                viewBox="6 6 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}
