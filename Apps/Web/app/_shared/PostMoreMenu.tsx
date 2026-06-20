"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { floraDurationMs } from "@/lib/floraMotion";
import {
  NOTCH_PANEL_CLIP_MIN_H,
  NOTCH_PANEL_FINE_GRID_PX,
  NOTCH_PANEL_GAP_PX,
  NOTCH_PANEL_PRIMARY_GRID_PX,
  notchPanelClipPath,
  notchPanelPathTopRight,
  readNotchPanelClipHeightPx,
  snapNotchPanelWidthToFineGrid,
} from "@/app/_shared/floraNotchPanel";
import styles from "./PostMoreMenu.module.css";

/** Горизонтальные поля 1-й строки (синхронно с CSS). */
const POST_MORE_PAD_LEFT_TRIM_PX = 6;
const POST_MORE_PAD_RIGHT_EXTRA_PX = 3;
const FIRST_ROW_PAD_X_PX =
  5 * NOTCH_PANEL_PRIMARY_GRID_PX -
  NOTCH_PANEL_FINE_GRID_PX -
  POST_MORE_PAD_LEFT_TRIM_PX +
  POST_MORE_PAD_RIGHT_EXTRA_PX;

/** Синхронно с `postMorePopoverOut` (`--flora-duration-1` в PostMoreMenu.module.css). */
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

export type PostMoreMenuProps = {
  wrapClassName: string;
  buttonClassName: string;
  /** Если задан — пункт «Поделиться» ведёт по этому URL (Next.js Link). */
  sharePath?: string | null;
  /** Подписи для `role="dialog"` и кнопки-триггера (по умолчанию — контекст поста). */
  accessibility?: Partial<Record<keyof typeof DEFAULT_A11Y, string>>;
  /** `post` / `comment` — лента; `track` — меню трека в «Моя музыка». */
  variant?: "post" | "comment" | "track";
};

export function PostMoreMenu({
  wrapClassName,
  buttonClassName,
  sharePath,
  accessibility,
  variant = "post",
}: PostMoreMenuProps) {
  const a11y = { ...DEFAULT_A11Y, ...accessibility };
  const [open, setOpen] = useState(false);
  /** Пока true — играет только fade-out; `open` остаётся true до конца (✕, z-index). */
  const [isClosing, setIsClosing] = useState(false);
  const [clipBoxH, setClipBoxH] = useState(NOTCH_PANEL_CLIP_MIN_H);
  const [panelWidthPx, setPanelWidthPx] = useState(225);
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const firstBandRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  const requestClose = useCallback(() => {
    if (!open || isClosing) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpen(false);
      setIsClosing(false);
      return;
    }
    setIsClosing(true);
  }, [open, isClosing]);

  useEffect(() => {
    if (!isClosing) return;
    const t = window.setTimeout(() => {
      setOpen(false);
      setIsClosing(false);
    }, CLOSE_ANIM_MS);
    return () => window.clearTimeout(t);
  }, [isClosing]);

  useEffect(() => {
    if (!open || isClosing) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const el = wrapRef.current;
      if (!el || el.contains(e.target as Node)) return;
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

  useLayoutEffect(() => {
    if (!open) return;
    const inner = innerRef.current;
    if (!inner) return;
    const applyWidthFromIntrinsic = () => {
      inner.style.width = "";
      const band = firstBandRef.current;
      const scroll = scrollRef.current;
      const btn = firstActionRef.current;
      /* Видимый правый край на высоте 1-й строки — вертикаль у x = W − NOTCH_GAP (вырез под ⋮), не x = W. */
      const firstMin = btn ? btn.scrollWidth + FIRST_ROW_PAD_X_PX + NOTCH_PANEL_GAP_PX : 0;
      const rawW = Math.max(band?.offsetWidth ?? 0, scroll?.offsetWidth ?? 0, firstMin);
      const w = snapNotchPanelWidthToFineGrid(rawW);
      inner.style.width = `${w}px`;
      setPanelWidthPx(w);
    };
    applyWidthFromIntrinsic();
    const h0 = readNotchPanelClipHeightPx(inner);
    setClipBoxH(h0);
    const ro = new ResizeObserver(() => {
      const el = innerRef.current;
      if (!el) return;
      setClipBoxH(readNotchPanelClipHeightPx(el));
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      inner.style.width = "";
    };
  }, [open, variant]);

  const clipPathStyle = useMemo(
    () => notchPanelClipPath("top-right", clipBoxH, panelWidthPx),
    [clipBoxH, panelWidthPx],
  );
  const outlinePathD = useMemo(
    () => notchPanelPathTopRight(clipBoxH, panelWidthPx),
    [clipBoxH, panelWidthPx],
  );
  /** Крестик только пока меню реально открыто; при `isClosing` сразу кроссфейд на ⋮ вместе с fade панели. */
  const showCloseGlyph = open && !isClosing;

  return (
    <div
      ref={wrapRef}
      className={`${wrapClassName} ${open ? styles.wrapOpen : ""}`}
      style={open ? { zIndex: 200 } : undefined}
    >
      {open ? (
        <div className={`${styles.popover} ${isClosing ? styles.popoverClosing : ""}`} role="presentation">
          <div className={styles.popoverClip}>
            <div
              ref={innerRef}
              className={styles.popoverInner}
              role="dialog"
              aria-label={a11y.dialog}
              style={{ clipPath: clipPathStyle, WebkitClipPath: clipPathStyle }}
            >
              <div ref={firstBandRef} className={styles.menuFirstBand}>
                {variant === "track" ? (
                  <button
                    ref={firstActionRef}
                    type="button"
                    className={styles.menuItemButton}
                    onClick={() => requestClose()}
                  >
                    <span className={styles.menuItemIcon}>
                      <IconSimilar />
                    </span>
                    <span className={styles.menuItemLabel}>Слушать похожие</span>
                  </button>
                ) : (
                  <button
                    ref={firstActionRef}
                    type="button"
                    className={styles.menuItemButton}
                    onClick={() => requestClose()}
                  >
                    <span className={styles.menuItemIcon}>
                      <IconSave />
                    </span>
                    <span className={styles.menuItemLabel}>Сохранить</span>
                  </button>
                )}
              </div>
              <div ref={scrollRef} className={styles.popoverScroll}>
                <div className={styles.menuScrollBand}>
                  {sharePath ? (
                    <Link href={sharePath} className={styles.menuItemButton} onClick={() => requestClose()}>
                      <span className={styles.menuItemIcon}>
                        <IconShare />
                      </span>
                      <span className={styles.menuItemLabel}>Поделиться</span>
                    </Link>
                  ) : (
                    <button type="button" className={styles.menuItemButton} onClick={() => requestClose()}>
                      <span className={styles.menuItemIcon}>
                        <IconShare />
                      </span>
                      <span className={styles.menuItemLabel}>Поделиться</span>
                    </button>
                  )}
                </div>
                {variant === "track" ? (
                  <div className={styles.menuScrollBand}>
                    <button type="button" className={styles.menuItemButton} onClick={() => requestClose()}>
                      <span className={styles.menuItemIcon}>
                        <IconPlaylist />
                      </span>
                      <span className={styles.menuItemLabel}>В плейлист</span>
                    </button>
                  </div>
                ) : null}
                {variant === "post" || variant === "track" ? (
                  <div className={styles.menuScrollBand}>
                    <button type="button" className={styles.menuItemButton} onClick={() => requestClose()}>
                      <span className={styles.menuItemIcon}>
                        <IconNotInterested />
                      </span>
                      <span className={styles.menuItemLabel}>Не интересно</span>
                    </button>
                  </div>
                ) : null}
                {variant === "post" ? (
                  <div className={styles.menuScrollBand}>
                    <button type="button" className={styles.menuItemButton} onClick={() => requestClose()}>
                      <span className={styles.menuItemIcon}>
                        <IconHideAuthor />
                      </span>
                      <span className={styles.menuItemLabel}>Скрыть автора</span>
                    </button>
                  </div>
                ) : null}
                <div className={styles.menuScrollBand}>
                  <button type="button" className={styles.menuItemButton} onClick={() => requestClose()}>
                    <span className={styles.menuItemIcon}>
                      <IconReport />
                    </span>
                    <span className={styles.menuItemLabel}>Пожаловаться</span>
                  </button>
                </div>
              </div>
            </div>
            <svg
              className={styles.outlineSvg}
              width={panelWidthPx}
              height={clipBoxH}
              viewBox={`0 0 ${panelWidthPx} ${clipBoxH}`}
              aria-hidden
            >
              <path className={styles.outlinePath} d={outlinePathD} fill="none" />
            </svg>
          </div>
        </div>
      ) : null}
      <button
        type="button"
        className={`${buttonClassName} ${styles.triggerLift} ${open ? styles.triggerOpen : ""} ${showCloseGlyph ? styles.triggerBackdropVisible : ""}`}
        title={open ? "Закрыть" : "Ещё"}
        aria-label={open ? a11y.triggerClose : a11y.triggerOpen}
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
        <span className={styles.triggerGlyphStack}>
          <span className={`${styles.triggerGlyph} ${showCloseGlyph ? "" : styles.triggerGlyphVisible}`} aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="12" cy="6" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="18" r="1.5" />
            </svg>
          </span>
          <span className={`${styles.triggerGlyph} ${showCloseGlyph ? styles.triggerGlyphVisible : ""}`} aria-hidden>
            <span className={styles.triggerCloseWrap}>
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
