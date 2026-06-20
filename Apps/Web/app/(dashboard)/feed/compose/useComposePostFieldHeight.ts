import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export const COMPOSE_POST_LINE_HEIGHT_PX = 25;
/** Совпадает с --compose-post-base-height: 5×15 + 5px */
export const COMPOSE_POST_BASE_HEIGHT_PX = 5 * 15 + 5;
const COMPOSE_POST_MAX_EXTRA_ROWS = 20;

function measureContentMetrics(input: HTMLTextAreaElement): { contentExtraPx: number; contentRows: number } {
  const computed = window.getComputedStyle(input);
  const measure = document.createElement("textarea");
  measure.value = input.value;
  measure.setAttribute("aria-hidden", "true");
  measure.style.position = "fixed";
  measure.style.left = "-9999px";
  measure.style.top = "0";
  measure.style.width = `${input.clientWidth}px`;
  measure.style.minHeight = "0";
  measure.style.height = "0";
  measure.style.padding = computed.padding;
  measure.style.border = computed.border;
  measure.style.boxSizing = computed.boxSizing;
  measure.style.font = computed.font;
  measure.style.letterSpacing = computed.letterSpacing;
  measure.style.lineHeight = computed.lineHeight;
  measure.style.whiteSpace = "pre-wrap";
  measure.style.wordBreak = "break-word";
  measure.style.overflow = "hidden";
  document.body.appendChild(measure);

  const contentRows = Math.max(1, Math.ceil(measure.scrollHeight / COMPOSE_POST_LINE_HEIGHT_PX));
  const growthPx = Math.max(0, measure.scrollHeight - COMPOSE_POST_BASE_HEIGHT_PX);
  measure.remove();

  return { contentExtraPx: growthPx, contentRows };
}

/**
 * Максимальный extra-рост поля, при котором контент compose не превышает вьюпорт
 * скролла (дефолтный скроллбар не появляется). Учитывает всё, что выше и ниже
 * поля внутри скролл-контейнера — в том числе блок прикреплённых фото.
 */
function measureViewportMaxExtraPx(scrollEl: HTMLElement, fieldWrapEl: HTMLElement): number {
  const scrollRect = scrollEl.getBoundingClientRect();
  const wrapRect = fieldWrapEl.getBoundingClientRect();
  // Координаты в системе контента скролла — не зависят от текущего scrollTop.
  const contentTop = scrollRect.top - scrollEl.scrollTop;
  const fieldTopOffset = wrapRect.top - contentTop;

  // Низ контента — по детям контейнера: scrollHeight зажимается до clientHeight
  // и не годится, когда контент короче вьюпорта.
  let contentBottom = wrapRect.bottom;
  for (const child of Array.from(scrollEl.children)) {
    const rect = child.getBoundingClientRect();
    if (rect.bottom > contentBottom) contentBottom = rect.bottom;
  }
  const paddingBottom = Number.parseFloat(window.getComputedStyle(scrollEl).paddingBottom) || 0;
  const belowPx = contentBottom + paddingBottom - wrapRect.bottom;

  const maxFieldPx = scrollEl.clientHeight - fieldTopOffset - belowPx;
  const maxExtraPx = Math.floor((maxFieldPx - COMPOSE_POST_BASE_HEIGHT_PX) / COMPOSE_POST_LINE_HEIGHT_PX) *
    COMPOSE_POST_LINE_HEIGHT_PX;
  return Math.max(0, maxExtraPx);
}

export type ComposePostFieldHeight = {
  style: CSSProperties;
  extraHeightPx: number;
  visibleRows: number;
};

export function useComposePostFieldHeight(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  scrollRef?: RefObject<HTMLElement | null>,
  /** Меняется при изменении набора прикреплённых фото — триггер пересчёта. */
  attachmentsKey?: string,
): ComposePostFieldHeight {
  const [extraHeightPx, setExtraHeightPx] = useState(0);
  const [visibleRows, setVisibleRows] = useState(1);

  const syncAutoHeight = useCallback(() => {
    const input = textareaRef.current;
    if (!input) return;

    const { contentExtraPx, contentRows } = measureContentMetrics(input);
    const contentExtraRows = Math.ceil(contentExtraPx / COMPOSE_POST_LINE_HEIGHT_PX);
    let extraPx = Math.min(contentExtraRows, COMPOSE_POST_MAX_EXTRA_ROWS) * COMPOSE_POST_LINE_HEIGHT_PX;

    const scrollEl = scrollRef?.current;
    const fieldWrapEl = input.parentElement;
    if (scrollEl && fieldWrapEl) {
      extraPx = Math.min(extraPx, measureViewportMaxExtraPx(scrollEl, fieldWrapEl));
    }

    const displayedRows = Math.floor(
      (COMPOSE_POST_BASE_HEIGHT_PX + extraPx) / COMPOSE_POST_LINE_HEIGHT_PX,
    );
    setExtraHeightPx(extraPx);
    setVisibleRows(Math.max(1, Math.min(contentRows, displayedRows)));
    // Высота только из CSS (как в messages); сброс inline, чтобы поле сужалось при удалении текста.
    input.style.removeProperty("height");
  }, [scrollRef, textareaRef]);

  useLayoutEffect(() => {
    syncAutoHeight();
  }, [syncAutoHeight, value, attachmentsKey]);

  useLayoutEffect(() => {
    window.addEventListener("resize", syncAutoHeight);
    return () => window.removeEventListener("resize", syncAutoHeight);
  }, [syncAutoHeight]);

  // Фото грузятся асинхронно (blob URL) — следим за фактической высотой контента.
  useLayoutEffect(() => {
    const input = textareaRef.current;
    const scrollEl = scrollRef?.current;
    if (!input || !scrollEl || typeof ResizeObserver === "undefined") return;

    const stack = input.parentElement?.parentElement;
    const ro = new ResizeObserver(() => syncAutoHeight());
    if (stack) ro.observe(stack);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollRef, syncAutoHeight, textareaRef]);

  return {
    style: {
      "--compose-post-extra-height": `${extraHeightPx}px`,
    } as CSSProperties,
    extraHeightPx,
    visibleRows,
  };
}
