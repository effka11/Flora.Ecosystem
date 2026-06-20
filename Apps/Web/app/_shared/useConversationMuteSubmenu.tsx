"use client";

import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { floraDurationMs } from "@/lib/floraMotion";
import { FLORA_RECT_MENU_OVERLAY_ATTR, FLORA_RECT_MENU_PANEL_ATTR } from "./floraRectMenuOverlay";
import rectStyles from "./FloraRectMenu.module.css";

export const SUBMENU_CLOSE_ANIM_MS = floraDurationMs(1) + 50;

export type SubmenuPosition = { top: number; left: number };

export function measureMuteSubmenuPosition(trigger: HTMLElement): SubmenuPosition {
  const root = trigger.ownerDocument.documentElement;
  const step = Number.parseFloat(getComputedStyle(root).getPropertyValue("--flora-grid-step")) || 15;
  const panel = trigger.closest(`[${FLORA_RECT_MENU_PANEL_ATTR}]`);
  const anchor = panel instanceof HTMLElement ? panel : trigger;
  const rect = anchor.getBoundingClientRect();
  return { top: rect.top, left: rect.right + step };
}

type UseConversationMuteSubmenuOptions = {
  enabled: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  menuIsClosing: boolean;
  conversationIsMuted: boolean;
  onSubmenuItemPick: () => void;
  onConversationMuteForever?: () => void;
  onConversationMuteTemporary?: () => void;
  onConversationUnmute?: () => void;
};

export function useConversationMuteSubmenu({
  enabled,
  triggerRef,
  menuIsClosing,
  conversationIsMuted,
  onSubmenuItemPick,
  onConversationMuteForever,
  onConversationMuteTemporary,
  onConversationUnmute,
}: UseConversationMuteSubmenuOptions) {
  const [muteSubmenuOpen, setMuteSubmenuOpen] = useState(false);
  const [isSubmenuClosing, setIsSubmenuClosing] = useState(false);
  const [submenuPos, setSubmenuPos] = useState<SubmenuPosition | null>(null);
  const [portalReady, setPortalReady] = useState(false);

  const submenuMounted = enabled && (muteSubmenuOpen || isSubmenuClosing);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  const resetSubmenu = useCallback(() => {
    setMuteSubmenuOpen(false);
    setIsSubmenuClosing(false);
    setSubmenuPos(null);
  }, []);

  const updateSubmenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setSubmenuPos(measureMuteSubmenuPosition(trigger));
  }, [triggerRef]);

  const requestSubmenuClose = useCallback(() => {
    if (!enabled || !muteSubmenuOpen || isSubmenuClosing) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMuteSubmenuOpen(false);
      setIsSubmenuClosing(false);
      return;
    }
    setIsSubmenuClosing(true);
  }, [enabled, muteSubmenuOpen, isSubmenuClosing]);

  useEffect(() => {
    if (!enabled || !menuIsClosing) return;
    if (muteSubmenuOpen && !isSubmenuClosing) requestSubmenuClose();
  }, [enabled, menuIsClosing, muteSubmenuOpen, isSubmenuClosing, requestSubmenuClose]);

  useEffect(() => {
    if (!isSubmenuClosing) return;
    const t = window.setTimeout(() => {
      setMuteSubmenuOpen(false);
      setIsSubmenuClosing(false);
    }, SUBMENU_CLOSE_ANIM_MS);
    return () => window.clearTimeout(t);
  }, [isSubmenuClosing]);

  useLayoutEffect(() => {
    if (!submenuMounted) {
      setSubmenuPos(null);
      return;
    }
    updateSubmenuPosition();
    window.addEventListener("resize", updateSubmenuPosition);
    window.addEventListener("scroll", updateSubmenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateSubmenuPosition);
      window.removeEventListener("scroll", updateSubmenuPosition, true);
    };
  }, [submenuMounted, updateSubmenuPosition]);

  const toggleMuteSubmenu = useCallback(() => {
    if (!enabled || isSubmenuClosing) return;
    if (muteSubmenuOpen) requestSubmenuClose();
    else {
      setIsSubmenuClosing(false);
      setMuteSubmenuOpen(true);
    }
  }, [enabled, isSubmenuClosing, muteSubmenuOpen, requestSubmenuClose]);

  const submenuStyle: CSSProperties | undefined =
    submenuPos === null ? undefined : { top: submenuPos.top, left: submenuPos.left };

  const submenuPortal =
    enabled &&
    portalReady &&
    submenuMounted &&
    submenuPos !== null &&
    createPortal(
      <div
        className={`${rectStyles.menuSubmenuPanel} ${rectStyles.menuSubmenuPanelDetached} ${isSubmenuClosing ? rectStyles.menuSubmenuPanelClosing : ""}`}
        style={submenuStyle}
        role="menu"
        aria-label="Заглушить"
        {...{ [FLORA_RECT_MENU_OVERLAY_ATTR]: "" }}
      >
        <button
          type="button"
          className={rectStyles.menuSubmenuItem}
          role="menuitem"
          onClick={() => {
            onConversationMuteForever?.();
            onSubmenuItemPick();
          }}
        >
          Насовсем
        </button>
        <button
          type="button"
          className={rectStyles.menuSubmenuItem}
          role="menuitem"
          onClick={() => {
            onConversationMuteTemporary?.();
            onSubmenuItemPick();
          }}
        >
          На время
        </button>
        <button
          type="button"
          className={rectStyles.menuSubmenuItem}
          role="menuitem"
          disabled={!conversationIsMuted}
          aria-disabled={!conversationIsMuted}
          onClick={() => {
            if (!conversationIsMuted) return;
            onConversationUnmute?.();
            onSubmenuItemPick();
          }}
        >
          Размутить
        </button>
        <button type="button" className={rectStyles.menuSubmenuItem} role="menuitem" onClick={onSubmenuItemPick}>
          Параметры
        </button>
      </div>,
      document.body,
    );

  return {
    muteSubmenuOpen,
    isSubmenuClosing,
    toggleMuteSubmenu,
    resetSubmenu,
    submenuPortal,
  };
}
