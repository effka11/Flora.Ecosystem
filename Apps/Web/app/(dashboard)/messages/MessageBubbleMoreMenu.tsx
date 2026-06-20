"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { floraDurationMs } from "@/lib/floraMotion";
import {
  FLORA_RECT_MENU_PANEL_ATTR,
  isFloraRectMenuOverlayTarget,
  isFloraRectMenuPanelTarget,
  measureMessageBubbleMoreTriggerPosition,
  measureRectMenuPanelPosition,
} from "@/app/_shared/floraRectMenuOverlay";
import rectStyles from "@/app/_shared/FloraRectMenu.module.css";
import triggerStyles from "@/app/_shared/PostMoreMenu.module.css";
import { MessageBubbleMoreMenuPanel } from "./MessageBubbleMoreMenuPanel";

const CLOSE_ANIM_MS = floraDurationMs(1) + 50;

export const FLORA_MESSAGE_BUBBLE_MORE_ATTR = "data-flora-message-bubble-more";

export type MessageBubbleMoreMenuProps = {
  anchorRef: RefObject<HTMLElement | null>;
  isFromMe: boolean;
  wrapClassName: string;
  buttonClassName: string;
  onReply?: () => void;
  onCopy?: () => void;
  onForward?: () => void;
  onPin?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
};

export type MessageBubbleAnchorProps = {
  anchorClassName: string;
  isFromMe: boolean;
  wrapClassName: string;
  buttonClassName: string;
  onCopy?: () => void;
  onReply?: () => void;
  onDelete?: () => void;
  children: ReactNode;
};

export function MessageBubbleAnchor({
  anchorClassName,
  isFromMe,
  wrapClassName,
  buttonClassName,
  onCopy,
  onReply,
  onDelete,
  children,
}: MessageBubbleAnchorProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchorRef} className={anchorClassName}>
      <MessageBubbleMoreMenu
        anchorRef={anchorRef}
        isFromMe={isFromMe}
        wrapClassName={wrapClassName}
        buttonClassName={buttonClassName}
        onCopy={onCopy}
        onReply={onReply}
        onDelete={onDelete}
      />
      {children}
    </div>
  );
}

function isNodeInBubbleRow(node: EventTarget | null, bubbleWrap: Element | null, moreWrap: HTMLElement | null): boolean {
  if (!(node instanceof Node)) return false;
  if (bubbleWrap?.contains(node)) return true;
  if (moreWrap?.contains(node)) return true;
  if (node instanceof Element && node.closest(`[${FLORA_MESSAGE_BUBBLE_MORE_ATTR}]`) === moreWrap) return true;
  return false;
}

export function MessageBubbleMoreMenu({
  anchorRef,
  isFromMe,
  wrapClassName,
  buttonClassName,
  onReply,
  onCopy,
  onForward,
  onPin,
  onEdit,
  onDelete,
}: MessageBubbleMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [panelPos, setPanelPos] = useState<CSSProperties | null>(null);
  const [triggerPos, setTriggerPos] = useState<CSSProperties | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  const panelMounted = open || isClosing;
  const visible = revealed || open;

  useEffect(() => {
    setPortalReady(true);
  }, []);

  const updateTriggerPosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) {
      setTriggerPos(null);
      return;
    }
    setTriggerPos(measureMessageBubbleMoreTriggerPosition(anchor));
  }, [anchorRef]);

  const updatePanelPosition = useCallback(() => {
    const wrap = wrapRef.current;
    const trigger = triggerRef.current;
    if (!wrap || !trigger) return;
    setPanelPos(measureRectMenuPanelPosition(wrap, trigger, "top-right"));
  }, []);

  const syncRevealedToPointer = useCallback(() => {
    const bubbleWrap = anchorRef.current?.closest("[data-messages-bubble-wrap]");
    const wrap = wrapRef.current;
    const hovered =
      (bubbleWrap instanceof HTMLElement && bubbleWrap.matches(":hover")) ||
      (wrap instanceof HTMLElement && wrap.matches(":hover"));
    setRevealed(hovered);
    if (!hovered) triggerRef.current?.blur();
  }, [anchorRef]);

  const requestClose = useCallback(() => {
    if (!open || isClosing) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpen(false);
      setIsClosing(false);
      syncRevealedToPointer();
      return;
    }
    setIsClosing(true);
  }, [open, isClosing, syncRevealedToPointer]);

  useEffect(() => {
    if (!isClosing) return;
    const t = window.setTimeout(() => {
      setOpen(false);
      setIsClosing(false);
      syncRevealedToPointer();
    }, CLOSE_ANIM_MS);
    return () => window.clearTimeout(t);
  }, [isClosing, syncRevealedToPointer]);

  useLayoutEffect(() => {
    updateTriggerPosition();
    window.addEventListener("resize", updateTriggerPosition);
    window.addEventListener("scroll", updateTriggerPosition, true);
    return () => {
      window.removeEventListener("resize", updateTriggerPosition);
      window.removeEventListener("scroll", updateTriggerPosition, true);
    };
  }, [updateTriggerPosition, visible]);

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
    const anchor = anchorRef.current;
    const bubbleWrap = anchor?.closest("[data-messages-bubble-wrap]");
    if (!(bubbleWrap instanceof HTMLElement)) return;

    const onRowEnter = () => setRevealed(true);
    const onRowLeave = (e: MouseEvent) => {
      if (isNodeInBubbleRow(e.relatedTarget, bubbleWrap, wrapRef.current)) return;
      if (isFloraRectMenuPanelTarget(e.relatedTarget)) return;
      setRevealed(false);
    };

    bubbleWrap.addEventListener("mouseenter", onRowEnter);
    bubbleWrap.addEventListener("mouseleave", onRowLeave);
    return () => {
      bubbleWrap.removeEventListener("mouseenter", onRowEnter);
      bubbleWrap.removeEventListener("mouseleave", onRowLeave);
    };
  }, [anchorRef]);

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
        className={`${rectStyles.menuPanel} ${rectStyles.menuPanelAnchorTopRight} ${rectStyles.menuPanelDetached} ${isClosing ? rectStyles.menuPanelClosing : ""}`}
        style={panelPos}
        role="dialog"
        aria-label="Меню сообщения"
        {...{ [FLORA_RECT_MENU_PANEL_ATTR]: "" }}
      >
        <MessageBubbleMoreMenuPanel
          isFromMe={isFromMe}
          firstActionRef={firstActionRef}
          onAction={requestClose}
          onReply={onReply}
          onCopy={onCopy}
          onForward={onForward}
          onPin={onPin}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
    ) : null;

  const triggerWrap = (
    <div
      ref={wrapRef}
      className={`${wrapClassName} ${open ? rectStyles.wrapOpen : ""}`}
      {...{ [FLORA_MESSAGE_BUBBLE_MORE_ATTR]: "" }}
      data-messages-bubble-more-open={open || undefined}
      data-messages-bubble-more-visible={visible || undefined}
      data-messages-bubble-more-me={isFromMe || undefined}
      style={{
        ...triggerPos,
        zIndex: open ? 200 : 6,
      }}
      onMouseEnter={() => setRevealed(true)}
      onMouseLeave={(e) => {
        const bubbleWrap = anchorRef.current?.closest("[data-messages-bubble-wrap]") ?? null;
        if (isNodeInBubbleRow(e.relatedTarget, bubbleWrap, wrapRef.current)) return;
        if (isFloraRectMenuPanelTarget(e.relatedTarget)) return;
        setRevealed(false);
      }}
    >
      {portalReady && menuPanel ? createPortal(menuPanel, document.body) : null}

      <button
        ref={triggerRef}
        type="button"
        className={`${buttonClassName} ${triggerStyles.triggerLift}`}
        title={open ? "Закрыть" : "Ещё"}
        aria-label={open ? "Закрыть меню сообщения" : "Меню сообщения"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (isClosing) return;
          if (open) requestClose();
          else {
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

  if (!portalReady || !triggerPos) return null;
  return createPortal(triggerWrap, document.body);
}
