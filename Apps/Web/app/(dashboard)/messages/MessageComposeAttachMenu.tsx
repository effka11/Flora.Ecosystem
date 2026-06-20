"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { measureComposeAttachMenuPanelPosition } from "@/app/_shared/floraRectMenuOverlay";
import { useComposePopoverPanelPosition } from "@/app/(dashboard)/feed/compose/useComposePopoverPanelPosition";
import { floraDurationMs } from "@/lib/floraMotion";
import styles from "./MessageComposeAttachMenu.module.css";

const COMPOSE_ATTACH_MENU_PANEL_ATTR = "data-flora-compose-attach-menu-panel";

const CLOSE_ANIM_MS = floraDurationMs(1) + 50;

export type ComposeAttachKind = "file" | "photo" | "video" | "music";

type AttachMenuItem = {
  id: ComposeAttachKind;
  label: string;
  accept: string | null;
  multiple?: boolean;
  Icon: () => JSX.Element;
};

const ATTACH_ITEMS: readonly AttachMenuItem[] = [
  { id: "photo", label: "Фото", accept: "image/jpeg,image/png,image/webp", multiple: true, Icon: IconPhoto },
  { id: "video", label: "Видео", accept: "video/*", Icon: IconVideo },
  { id: "music", label: "Музыка", accept: "audio/*", Icon: IconMusic },
];

const iconProps = {
  width: 18, height: 18,
  viewBox: "0 0 24 24" as const,
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

function IconPhoto() { return <svg {...iconProps}><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5" fill="currentColor" stroke="none"/><path d="M4 16l4.5-4.5 3 3L14 12l6 6"/></svg>; }
function IconVideo() { return <svg {...iconProps}><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3v-4z"/></svg>; }
function IconMusic() { return <svg {...iconProps}><path d="M9 18V6l10-2v12"/><circle cx="7"  cy="18" r="2.5" fill="currentColor" stroke="none"/><circle cx="17" cy="16" r="2.5" fill="currentColor" stroke="none"/></svg>; }

type AttachMenuTriggerVariant = "plus" | "paperclip";

type MessageComposeAttachMenuProps = {
  wrapClassName: string;
  buttonClassName: string;
  disabled?: boolean;
  closeNonce?: number;
  triggerVariant?: AttachMenuTriggerVariant;
  fieldAnchorRef?: RefObject<HTMLElement | null>;
  visibleRows?: number;
  /** Над кнопкой (чат) или под ней (лента compose по умолчанию). */
  panelPlacement?: "above" | "below";
  onOpenChange?: (open: boolean) => void;
  onPick?: (kind: ComposeAttachKind, files: FileList) => void;
};

function AttachMenuTriggerGlyph({
  variant,
  showClose,
}: {
  variant: AttachMenuTriggerVariant;
  showClose: boolean;
}) {
  if (showClose) {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  if (variant === "paperclip") {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21.44 11.05l-9.2 9.19a5 5 0 1 1-7.07-7.07l9.19-9.2a3 3 0 0 1 4.24 4.24l-9.2 9.2" />
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
    </svg>
  );
}

export function MessageComposeAttachMenu({
  wrapClassName,
  buttonClassName,
  disabled = false,
  closeNonce = 0,
  triggerVariant = "plus",
  fieldAnchorRef,
  visibleRows,
  panelPlacement = "below",
  onOpenChange,
  onPick,
}: MessageComposeAttachMenuProps) {
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  const wrapRef          = useRef<HTMLDivElement>(null);
  const triggerRef       = useRef<HTMLButtonElement>(null);
  const firstActionRef   = useRef<HTMLButtonElement>(null);
  const fileInputRefs    = useRef<Partial<Record<ComposeAttachKind, HTMLInputElement>>>({});
  const closeNonceSeenRef = useRef(closeNonce);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const emptyFieldAnchorRef = useRef<HTMLElement | null>(null);
  const [portalReady, setPortalReady] = useState(false);

  const panelMounted = open || isClosing;
  const resolvePanelEl = useCallback(() => panelRef.current, []);

  const { panelPos, lifted, liftAnimating } = useComposePopoverPanelPosition({
    panelMounted,
    hostRef: wrapRef,
    triggerRef,
    fieldAnchorRef: fieldAnchorRef ?? emptyFieldAnchorRef,
    visibleRows: fieldAnchorRef ? visibleRows : 1,
    preferAbove: panelPlacement === "above",
    resolvePanelEl,
    measure: measureComposeAttachMenuPanelPosition,
  });

  useEffect(() => {
    setPortalReady(true);
  }, []);

  const setOpenState = useCallback(
    (next: boolean) => { setOpen(next); onOpenChange?.(next); },
    [onOpenChange],
  );

  const requestClose = useCallback(() => {
    if (!open || isClosing) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpenState(false); setIsClosing(false); return;
    }
    setIsClosing(true);
  }, [open, isClosing, setOpenState]);

  useEffect(() => {
    if (closeNonce === closeNonceSeenRef.current) return;
    closeNonceSeenRef.current = closeNonce;
    if (open) requestClose();
  }, [closeNonce, open, requestClose]);

  useEffect(() => {
    if (!isClosing) return;
    const t = window.setTimeout(() => { setOpenState(false); setIsClosing(false); }, CLOSE_ANIM_MS);
    return () => window.clearTimeout(t);
  }, [isClosing, setOpenState]);

  useEffect(() => {
    if (!open || isClosing) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      const el = wrapRef.current;
      if (el?.contains(target)) return;
      if (target instanceof Element && target.closest(`[${COMPOSE_ATTACH_MENU_PANEL_ATTR}]`)) return;
      requestClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => firstActionRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, isClosing, requestClose]);

  const openFilePicker = useCallback(
    (kind: ComposeAttachKind) => { if (!disabled) fileInputRefs.current[kind]?.click(); },
    [disabled],
  );

  const handleActivate = useCallback(
    (item: AttachMenuItem) => {
      if (disabled) return;
      if (item.accept) openFilePicker(item.id);
    },
    [disabled, openFilePicker],
  );

  const handleFiles = useCallback(
    (kind: ComposeAttachKind, files: FileList | null) => {
      if (!files || files.length === 0) return;
      onPick?.(kind, files);
      requestClose();
    },
    [onPick, requestClose],
  );

  const showClose = open && !isClosing;

  const menuPanel = panelMounted ? (
      <div
        ref={panelRef}
        className={`${styles.menuPanel} ${styles.menuPanelDetached} ${liftAnimating ? styles.menuPanelLiftAnimating : ""} ${isClosing ? styles.menuPanelClosing : ""}`}
        style={panelPos ?? undefined}
        role="dialog"
        aria-label="Вложения"
        {...{ [COMPOSE_ATTACH_MENU_PANEL_ATTR]: "" }}
        {...(lifted ? { "data-compose-popover-lifted": "" } : {})}
      >
        {ATTACH_ITEMS.map((item, i) => (
          <button
            key={item.id}
            ref={i === 0 ? firstActionRef : undefined}
            type="button"
            className={styles.menuItem}
            onClick={() => handleActivate(item)}
          >
            <span className={styles.menuItemIcon} aria-hidden>
              <item.Icon />
            </span>
            <span className={styles.menuItemLabel}>{item.label}</span>
          </button>
        ))}
      </div>
  ) : null;

  return (
    <div
      ref={wrapRef}
      className={`${wrapClassName} ${open ? styles.wrapOpen : ""}`}
    >
      {portalReady && menuPanel ? createPortal(menuPanel, document.body) : null}

      {/* ── Скрытые file-input-ы ────────────────────────────────── */}
      {ATTACH_ITEMS.map((item) =>
        item.accept ? (
          <input
            key={item.id}
            ref={(node) => {
              if (node) fileInputRefs.current[item.id] = node;
              else delete fileInputRefs.current[item.id];
            }}
            type="file"
            className={styles.hiddenFileInput}
            accept={item.accept}
            multiple={item.multiple ?? false}
            tabIndex={-1}
            aria-hidden
            onChange={(e) => { handleFiles(item.id, e.target.files); e.target.value = ""; }}
          />
        ) : null,
      )}

      {/* ── Кнопка «+» / «×» ───────────────────────────────────── */}
      <button
        ref={triggerRef}
        type="button"
        className={`${buttonClassName} ${styles.composeTrigger}`}
        title={open ? "Закрыть" : "Вложения"}
        aria-label={open ? "Закрыть меню вложений" : "Вложения"}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          if (disabled || isClosing) return;
          if (open) requestClose();
          else { setOpenState(true); setIsClosing(false); }
        }}
      >
        <span className={styles.composeTriggerGlyphStack}>
          <span className={`${styles.composeTriggerGlyph} ${showClose ? "" : styles.composeTriggerGlyphVisible}`} aria-hidden>
            <AttachMenuTriggerGlyph variant={triggerVariant} showClose={false} />
          </span>
          <span className={`${styles.composeTriggerGlyph} ${showClose ? styles.composeTriggerGlyphVisible : ""}`} aria-hidden>
            <AttachMenuTriggerGlyph variant={triggerVariant} showClose />
          </span>
        </span>
      </button>
    </div>
  );
}
