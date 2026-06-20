"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./FloraHoverTooltip.module.css";

type TooltipPosition = { top: number; left: number };

type FloraHoverTooltipProps = {
  label: string;
  children: ReactNode;
  className?: string;
  /** Подпись для скринридеров у триггера. */
  ariaLabel?: string;
};

function measureTooltipPosition(anchor: HTMLElement): TooltipPosition {
  const rect = anchor.getBoundingClientRect();
  const root = anchor.ownerDocument.documentElement;
  const gap =
    Number.parseFloat(getComputedStyle(root).getPropertyValue("--flora-grid-step-fine")) || 5;
  return {
    top: rect.top - gap,
    left: rect.left + rect.width / 2,
  };
}

export function FloraHoverTooltip({ label, children, className, ariaLabel }: FloraHoverTooltipProps) {
  const tooltipId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const [portalReady, setPortalReady] = useState(false);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  const show = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    setPosition(measureTooltipPosition(el));
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    setOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = wrapRef.current;
      if (!el) return;
      setPosition(measureTooltipPosition(el));
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, label]);

  const bubble =
    portalReady &&
    open &&
    position !== null &&
    createPortal(
      <div
        id={tooltipId}
        role="tooltip"
        className={`${styles.bubble} ${styles.bubbleVisible}`}
        style={{
          top: position.top,
          left: position.left,
          transform: "translate(-50%, -100%)",
        }}
      >
        {label}
      </div>,
      document.body,
    );

  return (
    <>
      <span
        ref={wrapRef}
        className={className ? `${styles.wrap} ${className}` : styles.wrap}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-label={ariaLabel}
        aria-describedby={open ? tooltipId : undefined}
      >
        {children}
      </span>
      {bubble}
    </>
  );
}
