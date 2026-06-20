"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  bindComposePopoverPositionSync,
  type ComposePopoverMeasureOptions,
  type ComposePopoverMeasureResult,
} from "@/app/_shared/floraRectMenuOverlay";
import { floraDurationMs } from "@/lib/floraMotion";

/** --flora-duration-1 + ease-out (энергичный старт, чёткое приземление). */
const LIFT_TRANSITION_MS = floraDurationMs(1);
const LIFT_TRANSITION_CSS = `transform ${LIFT_TRANSITION_MS}ms cubic-bezier(0.33, 1, 0.2, 1)`;

type UseComposePopoverPanelPositionArgs = {
  panelMounted: boolean;
  hostRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  fieldAnchorRef: RefObject<HTMLElement | null>;
  visibleRows?: number;
  preferAbove?: boolean;
  resolvePanelEl?: () => HTMLElement | null;
  measure: (
    host: HTMLElement,
    trigger: HTMLElement,
    options?: ComposePopoverMeasureOptions,
  ) => ComposePopoverMeasureResult;
};

type PendingLiftSlide = {
  /** Позиционные свойства (top/bottom/left/right) + lifted‑флаг */
  targetStyle: CSSProperties;
  fromTop: number;
};

function cssLength(value: CSSProperties[keyof CSSProperties]): string {
  if (value == null) return "";
  return typeof value === "number" ? `${value}px` : String(value);
}

/**
 * Применяет позиционные свойства напрямую на DOM-элемент.
 * Нужно для FLIP — до того, как React сделает коммит состояния.
 */
function applyPositionToDom(
  el: HTMLElement,
  style: CSSProperties,
  extras?: { transform?: string; transition?: string },
) {
  el.style.position = "fixed";
  el.style.top    = style.top    !== undefined ? cssLength(style.top)    : "";
  el.style.bottom = style.bottom !== undefined ? cssLength(style.bottom) : "";
  el.style.left   = style.left   !== undefined ? cssLength(style.left)   : "";
  el.style.right  = style.right  !== undefined ? cssLength(style.right)  : "";
  el.style.transform  = extras?.transform  ?? "";
  el.style.transition = extras?.transition ?? "none";
}

/**
 * Обновляет только позиционные (top/bottom/left/right) свойства на DOM-элементе,
 * не трогая transform и transition — безопасно во время FLIP-анимации.
 */
function patchPositionOnDom(el: HTMLElement, style: CSSProperties) {
  if (style.top    !== undefined) el.style.top    = cssLength(style.top);
  if (style.bottom !== undefined) el.style.bottom = cssLength(style.bottom);
  if (style.left   !== undefined) el.style.left   = cssLength(style.left);
  if (style.right  !== undefined) el.style.right  = cssLength(style.right);
}

export function useComposePopoverPanelPosition({
  panelMounted,
  hostRef,
  triggerRef,
  fieldAnchorRef,
  visibleRows,
  preferAbove,
  resolvePanelEl,
  measure,
}: UseComposePopoverPanelPositionArgs) {
  const [panelPos, setPanelPos] = useState<CSSProperties | null>(null);
  const [lifted, setLifted] = useState(false);
  const [liftAnimating, setLiftAnimating] = useState(false);

  const liftedRef          = useRef(false);
  const hasPositionedRef   = useRef(false);
  const liftAnimatingRef   = useRef(false);
  const liftTimeoutRef     = useRef<number | null>(null);
  const pendingLiftRef     = useRef<PendingLiftSlide | null>(null);

  // ──────────────────────────────────────────────────────────────
  // finishLiftAnimation: просто убирает transform/transition.
  // Позиция к этому моменту уже актуальна — она обновлялась
  // во время анимации через patchPositionOnDom + setPanelPos.
  // ──────────────────────────────────────────────────────────────
  const finishLiftAnimation = useCallback(() => {
    if (!liftAnimatingRef.current) return;
    liftAnimatingRef.current = false;
    setLiftAnimating(false);
    if (liftTimeoutRef.current !== null) {
      window.clearTimeout(liftTimeoutRef.current);
      liftTimeoutRef.current = null;
    }
    // Снимаем только transform и transition; top/bottom/left/right — актуальны.
    setPanelPos((prev) => {
      if (!prev) return prev;
      const { transform: _t, transition: _tr, ...rest } = prev;
      return rest;
    });
  }, []);

  // ──────────────────────────────────────────────────────────────
  // Старт FLIP-анимации (вызывается, когда lifted меняется)
  // ──────────────────────────────────────────────────────────────
  const startLiftSlide = useCallback(
    (targetStyle: CSSProperties, nextLifted: boolean) => {
      const panelEl = resolvePanelEl?.() ?? null;
      const fromTop = panelEl?.getBoundingClientRect().top;

      liftedRef.current = nextLifted;
      setLifted(nextLifted);

      const reducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (reducedMotion || !panelEl || fromTop == null) {
        setPanelPos(targetStyle);
        hasPositionedRef.current = true;
        return;
      }

      pendingLiftRef.current = { targetStyle, fromTop };
      liftAnimatingRef.current = true;
      setLiftAnimating(true);
    },
    [resolvePanelEl],
  );

  // ──────────────────────────────────────────────────────────────
  // Фаза 2 FLIP — выполняется после рендера с liftAnimating=true.
  // ──────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!liftAnimating || !pendingLiftRef.current) return;

    const pending  = pendingLiftRef.current;
    pendingLiftRef.current = null;

    const panelEl = resolvePanelEl?.() ?? null;
    const { targetStyle, fromTop } = pending;

    if (!panelEl) {
      setPanelPos(targetStyle);
      hasPositionedRef.current = true;
      finishLiftAnimation();
      return;
    }

    // Применяем конечные координаты, чтобы измерить реальное toTop.
    applyPositionToDom(panelEl, targetStyle);
    const toTop  = panelEl.getBoundingClientRect().top;
    const deltaY = fromTop - toTop;

    if (Math.abs(deltaY) < 1) {
      setPanelPos(targetStyle);
      hasPositionedRef.current = true;
      finishLiftAnimation();
      return;
    }

    // Инвертируем: рисуем элемент в исходном положении (без анимации).
    const invertTransform = `translate3d(0, ${deltaY}px, 0)`;
    applyPositionToDom(panelEl, targetStyle, {
      transform:  invertTransform,
      transition: "none",
    });
    setPanelPos({ ...targetStyle, transform: invertTransform, transition: "none" });
    hasPositionedRef.current = true;

    // Через два rAF убираем инверсию — браузер начинает анимировать к translate(0,0).
    let rafId = 0;
    rafId = requestAnimationFrame(() => {
      rafId = requestAnimationFrame(() => {
        applyPositionToDom(panelEl, targetStyle, {
          transform:  "translate3d(0, 0, 0)",
          transition: LIFT_TRANSITION_CSS,
        });
        setPanelPos({
          ...targetStyle,
          transform:  "translate3d(0, 0, 0)",
          transition: LIFT_TRANSITION_CSS,
        });
      });
    });

    if (liftTimeoutRef.current !== null) window.clearTimeout(liftTimeoutRef.current);
    liftTimeoutRef.current = window.setTimeout(finishLiftAnimation, LIFT_TRANSITION_MS + 40);

    return () => { if (rafId !== 0) cancelAnimationFrame(rafId); };
  }, [finishLiftAnimation, liftAnimating, resolvePanelEl]);

  // ──────────────────────────────────────────────────────────────
  // Обновление позиции (ResizeObserver, scroll, resize).
  //
  // Ключевое: во время LIFT-анимации мы НЕ блокируем обновление
  // позиционных свойств (bottom/top). Поле может расти пока играет
  // анимация — мы обновляем координаты прямо на DOM и в стейте
  // (сохраняя текущий transform), поэтому в конце анимации
  // панель уже стоит точно — прыжка нет.
  // ──────────────────────────────────────────────────────────────
  const updatePanelPosition = useCallback(() => {
    const host    = hostRef.current;
    const trigger = triggerRef.current;
    if (!host || !trigger) return;

    const { style, lifted: nextLifted } = measure(host, trigger, { visibleRows, preferAbove });
    const liftChanged = nextLifted !== liftedRef.current;

    if (liftChanged && hasPositionedRef.current && !liftAnimatingRef.current) {
      startLiftSlide(style, nextLifted);
      return;
    }

    if (liftAnimatingRef.current) {
      // Обновляем только координаты, не трогая transform/transition.
      const panelEl = resolvePanelEl?.() ?? null;
      if (panelEl) patchPositionOnDom(panelEl, style);
      setPanelPos((prev) => {
        if (!prev) return prev;
        return { ...prev, ...style };
      });
      return;
    }

    liftedRef.current = nextLifted;
    setLifted(nextLifted);
    setPanelPos(style);
    hasPositionedRef.current = true;
  }, [hostRef, measure, preferAbove, resolvePanelEl, startLiftSlide, triggerRef, visibleRows]);

  // Монтирование / размонтирование панели.
  useLayoutEffect(() => {
    if (!panelMounted) {
      setPanelPos(null);
      setLifted(false);
      setLiftAnimating(false);
      liftedRef.current        = false;
      hasPositionedRef.current = false;
      liftAnimatingRef.current = false;
      pendingLiftRef.current   = null;
      if (liftTimeoutRef.current !== null) {
        window.clearTimeout(liftTimeoutRef.current);
        liftTimeoutRef.current = null;
      }
      return;
    }

    updatePanelPosition();
    const rafId = requestAnimationFrame(() => updatePanelPosition());
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [panelMounted, updatePanelPosition]);

  // Следим за ростом поля через ResizeObserver + transition‑rAF.
  useLayoutEffect(() => {
    if (!panelMounted) return;
    return bindComposePopoverPositionSync(
      [hostRef.current, fieldAnchorRef.current, triggerRef.current],
      updatePanelPosition,
    );
  }, [fieldAnchorRef, hostRef, panelMounted, triggerRef, updatePanelPosition]);

  // Слушаем transitionend на панели для досрочного завершения анимации.
  useEffect(() => {
    if (!panelMounted || !liftAnimating) return;
    const panelEl = resolvePanelEl?.() ?? null;
    if (!panelEl) return;

    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target !== panelEl || e.propertyName !== "transform") return;
      finishLiftAnimation();
    };

    panelEl.addEventListener("transitionend", onTransitionEnd);
    return () => panelEl.removeEventListener("transitionend", onTransitionEnd);
  }, [finishLiftAnimation, liftAnimating, panelMounted, resolvePanelEl]);

  return { panelPos, lifted, liftAnimating, updatePanelPosition };
}
