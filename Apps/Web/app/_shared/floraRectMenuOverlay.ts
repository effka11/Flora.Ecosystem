import type { CSSProperties } from "react";

/** Портал подменю PostMoreMenuRect — клик внутри не закрывает основное меню. */
export const FLORA_RECT_MENU_OVERLAY_ATTR = "data-flora-rect-menu-overlay";

/** Основная панель .menuPanel — якорь для позиции подменю. */
export const FLORA_RECT_MENU_PANEL_ATTR = "data-flora-rect-menu-panel";

export function isFloraRectMenuOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${FLORA_RECT_MENU_OVERLAY_ATTR}]`) !== null;
}

export function isFloraRectMenuPanelTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${FLORA_RECT_MENU_PANEL_ATTR}]`) !== null;
}

/** Разрешает calc(...) из CSS-переменной в px (через probe-элемент). */
export function resolveCssLengthPx(host: HTMLElement, value: string, fallbackPx: number): number {
  const trimmed = value.trim();
  if (!trimmed) return fallbackPx;
  const doc = host.ownerDocument;
  const probe = doc.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.height = trimmed;
  host.appendChild(probe);
  const px = probe.offsetHeight;
  probe.remove();
  return px > 0 ? px : fallbackPx;
}

/** Портал ⋮ у пузыря: 1 первичная клетка правее якоря; top = верх якоря − fine + 6px. */
export function measureMessageBubbleMoreTriggerPosition(anchor: HTMLElement): CSSProperties {
  const anchorRect = anchor.getBoundingClientRect();
  const cs = getComputedStyle(anchor);
  const step = Number.parseFloat(cs.getPropertyValue("--flora-grid-step")) || 15;
  const fine = resolveCssLengthPx(anchor, cs.getPropertyValue("--flora-grid-step-fine"), 5);
  return {
    position: "fixed",
    top: anchorRect.top - fine + 6,
    left: anchorRect.right + step,
    right: "auto",
  };
}

/** Позиция портала основной панели — синхронно с .menuPanelAnchor* в FloraRectMenu.module.css. */
export function measureRectMenuPanelPosition(
  wrap: HTMLElement,
  trigger: HTMLElement,
  anchor: "top-right" | "bottom-left",
): CSSProperties {
  const wrapRect = wrap.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  const cs = getComputedStyle(wrap);
  const step = Number.parseFloat(cs.getPropertyValue("--flora-grid-step")) || 15;

  if (anchor === "bottom-left") {
    const bottomCss = wrapRect.height - 8 - step + 2;
    return {
      position: "fixed",
      bottom: window.innerHeight - wrapRect.bottom + bottomCss,
      left: wrapRect.left - 1,
    };
  }

  const gapBelow = resolveCssLengthPx(
    wrap,
    cs.getPropertyValue("--flora-rect-menu-gap-below"),
    step,
  );

  return {
    position: "fixed",
    top: wrapRect.bottom + gapBelow,
    right: window.innerWidth - triggerRect.right,
  };
}

/** С 9-й строки панель одним шагом переезжает над кнопки. */
export const COMPOSE_POPOVER_LIFT_AFTER_VISIBLE_ROWS = 9;

export type ComposePopoverMeasureOptions = {
  visibleRows?: number;
  /** Всегда над триггером (например, «+» внизу чата). */
  preferAbove?: boolean;
};

export type ComposePopoverMeasureResult = {
  style: CSSProperties;
  lifted: boolean;
};

function measureComposePopoverPosition(
  host: HTMLElement,
  trigger: HTMLElement,
  horizontal: CSSProperties,
  options?: ComposePopoverMeasureOptions,
): ComposePopoverMeasureResult {
  const step = resolveCssLengthPx(host, "var(--flora-grid-step)", 15);
  const gap = step;
  const aboveGap = options?.preferAbove === true ? step * 2 : step;
  const triggerRect = trigger.getBoundingClientRect();
  const lifted =
    options?.preferAbove === true ||
    (options?.visibleRows ?? 1) >= COMPOSE_POPOVER_LIFT_AFTER_VISIBLE_ROWS;

  if (!lifted) {
    return {
      lifted: false,
      style: {
        position: "fixed",
        top: triggerRect.bottom + gap,
        bottom: "auto",
        ...horizontal,
      },
    };
  }

  return {
    lifted: true,
    style: {
      position: "fixed",
      top: "auto",
      bottom: window.innerHeight - triggerRect.top + aboveGap,
      ...horizontal,
    },
  };
}

/** Меню вложений: по умолчанию под кнопкой; preferAbove — над (чат); с 9-й строки compose — над. */
export function measureComposeAttachMenuPanelPosition(
  wrap: HTMLElement,
  trigger: HTMLElement,
  options?: ComposePopoverMeasureOptions,
): ComposePopoverMeasureResult {
  const wrapRect = wrap.getBoundingClientRect();
  return measureComposePopoverPosition(wrap, trigger, { left: wrapRect.left }, options);
}

/** Панель эмодзи: до 9 строк — под смайликом; с 9-й — над кнопкой. */
export function measureComposeStickerPanelPosition(
  alignSurface: HTMLElement,
  trigger: HTMLElement,
  options?: ComposePopoverMeasureOptions,
): ComposePopoverMeasureResult {
  const surfaceRect = alignSurface.getBoundingClientRect();
  return measureComposePopoverPosition(
    alignSurface,
    trigger,
    { right: window.innerWidth - surfaceRect.right },
    options,
  );
}

/** Следит за сдвигом кнопок при росте поля (transition min-height и layout). */
export function bindComposePopoverPositionSync(
  nodes: readonly (HTMLElement | null | undefined)[],
  onSync: () => void,
): () => void {
  const connected = nodes.filter((node): node is HTMLElement => node != null);
  if (connected.length === 0) return () => undefined;

  let rafId = 0;
  const scheduleSync = () => {
    if (rafId !== 0) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      onSync();
    });
  };

  const observer = new ResizeObserver(scheduleSync);
  for (const node of connected) observer.observe(node);

  let transitionRafId = 0;
  const stopTransitionSync = () => {
    if (transitionRafId === 0) return;
    cancelAnimationFrame(transitionRafId);
    transitionRafId = 0;
  };
  const runTransitionSync = () => {
    onSync();
    transitionRafId = requestAnimationFrame(runTransitionSync);
  };

  const onTransitionStart = (event: TransitionEvent) => {
    if (event.propertyName !== "min-height" && event.propertyName !== "height") return;
    stopTransitionSync();
    transitionRafId = requestAnimationFrame(runTransitionSync);
  };
  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.propertyName !== "min-height" && event.propertyName !== "height") return;
    stopTransitionSync();
    scheduleSync();
  };
  for (const node of connected) {
    node.addEventListener("transitionstart", onTransitionStart);
    node.addEventListener("transitionend", onTransitionEnd);
  }

  return () => {
    observer.disconnect();
    for (const node of connected) {
      node.removeEventListener("transitionstart", onTransitionStart);
      node.removeEventListener("transitionend", onTransitionEnd);
    }
    stopTransitionSync();
    if (rafId !== 0) cancelAnimationFrame(rafId);
  };
}

export const FLORA_COMPOSE_STICKER_PANEL_ATTR = "data-flora-compose-sticker-panel";

export function isFloraComposeStickerPanelTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${FLORA_COMPOSE_STICKER_PANEL_ATTR}]`) !== null;
}

