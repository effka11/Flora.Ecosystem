import type { ViewStyle } from "react-native";
import { floraSpacing } from "@/lib/theme";

export type BubbleBoxRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

export type BubbleAnchorRect = BubbleBoxRect & {
  /**
   * Visual window Y for above/below: reconstructed bubble midpoint when the
   * press has window + local Y, otherwise the finger's window Y.
   * Never use inverted `measure().pageY` for this.
   */
  originY: number;
  /** Visual bubble top from press (`pageY - locationY`). Null if Yoga/local Y missing. */
  visualTop: number | null;
  /** `visualTop + yogaHeight`. Null if edges could not be reconstructed. */
  visualBottom: number | null;
  /** Yoga `onLayout.height` of the pressable. Not derived from visualTop. */
  yogaHeight: number;
};

export type MessageMenuListMotion = "offset-change" | "user-drag";

/** Chrome around rows — padding of the panel (1.5×fine × 2). */
const MENU_PANEL_CHROME_PX = 15;
/** One MenuRow: vertical padding + icon line. */
export const MENU_ROW_HEIGHT_PX = 39;

/** FloraRectMenu: 0.5×fine toward the aligned edge. */
export function MENU_PANEL_EMERGE_X_PX() {
  return 0.5 * floraSpacing.gridFine;
}
/** FloraRectMenu: fine + 3 toward the bubble. */
export function MENU_PANEL_EMERGE_Y_PX() {
  return floraSpacing.gridFine + 3;
}

export type MenuPanelTransformOrigin = "top right" | "top left" | "bottom right" | "bottom left";

export type MenuPanelMotion = {
  transformOrigin: MenuPanelTransformOrigin;
  emergeX: number;
  emergeY: number;
};

/**
 * Enter/exit offset and origin for the docked bubble menu.
 * `emergeY < 0` starts above the rest position (menu below the bubble).
 */
export function resolveMenuPanelMotion(
  placement: "above" | "below",
  isFromMe: boolean,
): MenuPanelMotion {
  const emergeX = isFromMe ? MENU_PANEL_EMERGE_X_PX() : -MENU_PANEL_EMERGE_X_PX();
  const emergeY = placement === "below" ? -MENU_PANEL_EMERGE_Y_PX() : MENU_PANEL_EMERGE_Y_PX();
  const transformOrigin: MenuPanelTransformOrigin =
    placement === "below"
      ? isFromMe
        ? "top right"
        : "top left"
      : isFromMe
        ? "bottom right"
        : "bottom left";
  return { transformOrigin, emergeX, emergeY };
}

/**
 * Keyboard / dock / KCSV corrections fire `onScroll` without a finger drag.
 * Opening the menu dismisses the keyboard, so those offset changes must not
 * close a menu that just opened. Finger drag is the dismiss gesture.
 */
export function shouldCloseMessageMenuOnListMotion(motion: MessageMenuListMotion): boolean {
  return motion === "user-drag";
}

export function bubbleAnchorsEqual(a: BubbleAnchorRect, b: BubbleAnchorRect): boolean {
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.originY === b.originY &&
    a.visualTop === b.visualTop &&
    a.visualBottom === b.visualBottom &&
    a.yogaHeight === b.yogaHeight
  );
}

export function estimateMenuPanelHeight(
  isFromMe: boolean,
  canDelete: boolean,
  canReport = false,
): number {
  const extra =
    (isFromMe ? 1 : 0) + (isFromMe && canDelete ? 1 : 0) + (!isFromMe && canReport ? 1 : 0);
  return MENU_PANEL_CHROME_PX + (4 + extra) * MENU_ROW_HEIGHT_PX;
}

export function shiftMenuAnchor(prev: BubbleAnchorRect, box: BubbleBoxRect): BubbleAnchorRect {
  return {
    ...box,
    originY: prev.originY,
    visualTop: prev.visualTop,
    visualBottom: prev.visualBottom,
    yogaHeight: prev.yogaHeight,
  };
}

const MENU_PANEL_MIN_WIDTH_PX = 200;

/** Fallback width until the docked panel reports `onLayout`. */
export function estimateMenuPanelWidth(): number {
  return MENU_PANEL_MIN_WIDTH_PX;
}

/**
 * Visual window box of the CSS-docked panel.
 * Vertical pin uses press-space `originY` (not inverted `measure().pageY`).
 */
export function menuPanelWindowRect(args: {
  placement: "above" | "below";
  originY: number;
  bubbleLeft: number;
  bubbleRight: number;
  bubbleHeight: number;
  panelWidth: number;
  panelHeight: number;
  menuGap: number;
  isFromMe: boolean;
}): BubbleBoxRect {
  const bubbleHeight = Math.max(0, args.bubbleHeight);
  const visualTop = args.originY - bubbleHeight / 2;
  const visualBottom = visualTop + bubbleHeight;
  const top =
    args.placement === "below"
      ? visualBottom + args.menuGap
      : visualTop - args.menuGap - args.panelHeight;
  const width = Math.max(0, args.panelWidth);
  const left = args.isFromMe ? args.bubbleRight - width : args.bubbleLeft;
  return {
    top,
    left,
    right: left + width,
    bottom: top + args.panelHeight,
  };
}

export type MenuDismissHostRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DockedMenuFit = {
  placement: "above" | "below";
  /** Visual window-space: positive moves the panel down. */
  shiftY: number;
  rect: BubbleBoxRect;
};

function offsetRectY(rect: BubbleBoxRect, dy: number): BubbleBoxRect {
  return { ...rect, top: rect.top + dy, bottom: rect.bottom + dy };
}

export function menuFeedSafeBand(
  feedTopY: number,
  feedBottomY: number,
  feedInset: number,
): { minTop: number; maxBottom: number } {
  const minTop = feedTopY + feedInset;
  const maxBottom = feedBottomY - feedInset;
  return { minTop, maxBottom: Math.max(minTop, maxBottom) };
}

export function menuPanelFitsFeedBand(
  panel: BubbleBoxRect,
  minTop: number,
  maxBottom: number,
): boolean {
  return panel.top >= minTop - 0.5 && panel.bottom <= maxBottom + 0.5;
}

/** Shift (down positive) so the panel sits inside `[minTop, maxBottom]`. */
export function menuPanelShiftYIntoBand(
  panel: BubbleBoxRect,
  minTop: number,
  maxBottom: number,
): number {
  const height = panel.bottom - panel.top;
  const band = maxBottom - minTop;
  if (height >= band) return minTop - panel.top;
  if (panel.top < minTop) return minTop - panel.top;
  if (panel.bottom > maxBottom) return maxBottom - panel.bottom;
  return 0;
}

export type LockedMenuFit = {
  placement: "above" | "below";
  /** Visual window-space: positive moves the CSS-docked panel down. */
  shiftY: number;
};

/**
 * One-shot side + overflow shift at tap. Does not flip. Does not use inverted
 * `measure().pageY`. Bottom clamp only when `allowBottomClamp` (keyboard closed).
 */
export function lockMenuFit(args: {
  visualTop: number | null | undefined;
  visualBottom: number | null | undefined;
  pressWindowY?: number | null;
  feedTopY: number | null;
  feedBottomY: number | null;
  windowHeight: number;
  panelHeight: number;
  menuGap: number;
  feedInset: number;
  allowBottomClamp: boolean;
}): LockedMenuFit {
  const feedTopY = args.feedTopY;
  const feedBottomY = args.feedBottomY;
  const hasFeed = feedTopY != null && feedBottomY != null;
  const placementTop = hasFeed ? feedTopY : 0;
  const placementBottom = hasFeed ? feedBottomY : args.windowHeight;
  const edgeTop = args.visualTop;
  const edgeBottom = args.visualBottom;
  const visualY =
    edgeTop != null && edgeBottom != null && edgeBottom > edgeTop
      ? (edgeTop + edgeBottom) / 2
      : (args.pressWindowY ?? (placementTop + placementBottom) / 2);
  const placement = resolveMenuPlacement({
    visualY,
    feedTopY: placementTop,
    feedBottomY: placementBottom,
  });

  // CSS-docked `above` must not take a window-space translateY (fights the 5px pin).
  if (placement === "above") {
    return { placement, shiftY: 0 };
  }

  if (edgeTop == null || edgeBottom == null || feedTopY == null || feedBottomY == null || edgeBottom <= edgeTop) {
    return { placement, shiftY: 0 };
  }

  const minTop = feedTopY + args.feedInset;
  const predictedTop = edgeBottom + args.menuGap;
  const predictedBottom = predictedTop + args.panelHeight;

  if (predictedTop < minTop - 0.5) {
    return { placement, shiftY: minTop - predictedTop };
  }
  if (!args.allowBottomClamp) {
    return { placement, shiftY: 0 };
  }

  const maxBottom = feedBottomY - args.feedInset;
  if (args.panelHeight >= maxBottom - minTop) {
    return { placement, shiftY: minTop - predictedTop };
  }
  if (predictedBottom > maxBottom + 0.5) {
    return { placement, shiftY: maxBottom - predictedBottom };
  }
  return { placement, shiftY: 0 };
}

export type AboveDockTop = {
  clipLocal: number;
  clearanceLocal: number;
  aboveAnchorTop: number;
};

const ABOVE_DOCK_ZERO: AboveDockTop = {
  clipLocal: 0,
  clearanceLocal: 0,
  aboveAnchorTop: 0,
};

/**
 * Yoga `top` for the above-dock zero-height anchor: 5px from the visible bubble
 * top, plus the shortfall to keep `feedTopY + feedInset`. Does not use `originY`.
 * No 20px guarantee when `visualTop` or `feedTopY` is missing.
 */
export function resolveAboveDockTop(args: {
  visualTop: number | null | undefined;
  feedTopY: number | null;
  panelHeight: number;
  menuGap: number;
  feedInset: number;
}): AboveDockTop {
  const visualTop = args.visualTop;
  const feedTopY = args.feedTopY;
  if (
    visualTop == null ||
    feedTopY == null ||
    !Number.isFinite(visualTop) ||
    !Number.isFinite(feedTopY) ||
    args.panelHeight <= 0
  ) {
    return ABOVE_DOCK_ZERO;
  }
  const clipLocal = Math.max(0, feedTopY - visualTop);
  const visibleTop = Math.max(visualTop, feedTopY);
  const predictedTop = visibleTop - args.menuGap - args.panelHeight;
  const clearanceLocal = Math.max(0, feedTopY + args.feedInset - predictedTop);
  return {
    clipLocal,
    clearanceLocal,
    aboveAnchorTop: clipLocal + clearanceLocal,
  };
}

/**
 * Prefer midpoint side with the 5px bubble gap, flip if that side leaves the
 * feed band (header/compose + inset), otherwise translate into the band.
 */
export function resolveDockedMenuFit(args: {
  originY: number;
  bubbleLeft: number;
  bubbleRight: number;
  bubbleHeight: number;
  panelWidth: number;
  panelHeight: number;
  menuGap: number;
  feedTopY: number;
  feedBottomY: number;
  feedInset: number;
  isFromMe: boolean;
}): DockedMenuFit {
  const placement = resolveMenuPlacement({
    visualY: args.originY,
    feedTopY: args.feedTopY,
    feedBottomY: args.feedBottomY,
  });
  const { minTop, maxBottom } = menuFeedSafeBand(args.feedTopY, args.feedBottomY, args.feedInset);
  const box = {
    originY: args.originY,
    bubbleLeft: args.bubbleLeft,
    bubbleRight: args.bubbleRight,
    bubbleHeight: args.bubbleHeight,
    panelWidth: args.panelWidth,
    panelHeight: args.panelHeight,
    menuGap: args.menuGap,
    isFromMe: args.isFromMe,
  };
  const preferred = menuPanelWindowRect({ ...box, placement });
  if (menuPanelFitsFeedBand(preferred, minTop, maxBottom)) {
    return { placement, shiftY: 0, rect: preferred };
  }
  const other: "above" | "below" = placement === "below" ? "above" : "below";
  const flipped = menuPanelWindowRect({ ...box, placement: other });
  if (menuPanelFitsFeedBand(flipped, minTop, maxBottom)) {
    return { placement: other, shiftY: 0, rect: flipped };
  }
  const shiftY = menuPanelShiftYIntoBand(preferred, minTop, maxBottom);
  return { placement, shiftY, rect: offsetRectY(preferred, shiftY) };
}

/**
 * Four strips around `panel` in `host` local space. Empty strips are omitted.
 * Overlay must sit in the same window as the docked panel (not a native Modal).
 */
export function menuDismissStrips(
  panel: BubbleBoxRect,
  host: MenuDismissHostRect,
): { key: string; style: ViewStyle }[] {
  const left = clamp(panel.left - host.x, 0, host.width);
  const right = clamp(panel.right - host.x, 0, host.width);
  const top = clamp(panel.top - host.y, 0, host.height);
  const bottom = clamp(panel.bottom - host.y, 0, host.height);
  const midH = Math.max(0, bottom - top);
  const strips: { key: string; style: ViewStyle }[] = [];
  if (top > 0) {
    strips.push({
      key: "n",
      style: { position: "absolute", left: 0, right: 0, top: 0, height: top },
    });
  }
  if (bottom < host.height) {
    strips.push({
      key: "s",
      style: { position: "absolute", left: 0, right: 0, top: bottom, bottom: 0 },
    });
  }
  if (left > 0 && midH > 0) {
    strips.push({
      key: "w",
      style: { position: "absolute", left: 0, width: left, top, height: midH },
    });
  }
  if (right < host.width && midH > 0) {
    strips.push({
      key: "e",
      style: { position: "absolute", left: right, right: 0, top, height: midH },
    });
  }
  return strips;
}

function readFiniteY(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type MenuPressCoords = {
  windowY: number;
  locationY: number | null;
};

/**
 * Visual window Y of a press. RNGH Pressable maps `absoluteY` → `nativeEvent.pageY`.
 * Also reads the event object itself (gesture payload) and `onPressIn` captures.
 * Local `y` / `locationY` are not window-space — they only reconstruct the bubble mid.
 */
export function readMenuPressCoords(event: unknown): MenuPressCoords | null {
  if (event == null || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  const native =
    record.nativeEvent && typeof record.nativeEvent === "object"
      ? (record.nativeEvent as Record<string, unknown>)
      : null;
  const windowY =
    readFiniteY(native?.pageY) ??
    readFiniteY(native?.absoluteY) ??
    readFiniteY(record.pageY) ??
    readFiniteY(record.absoluteY);
  if (windowY == null) return null;
  const locationY =
    readFiniteY(native?.locationY) ?? readFiniteY(record.locationY) ?? null;
  return { windowY, locationY };
}

/**
 * Visual midpoint of the bubble: window press minus local Y plus half height.
 * Chat rows are `scaleY: -1` twice (list + row), so RNGH local Y is upright.
 * `measure().pageY` is not used — it does not match the screen after invert.
 */
export function visualMenuOriginY(args: {
  pressWindowY: number | null;
  locationY: number | null;
  bubbleHeight: number;
  fallbackY: number;
}): number {
  const { pressWindowY, locationY, bubbleHeight, fallbackY } = args;
  if (pressWindowY == null) return fallbackY;
  if (
    locationY != null &&
    bubbleHeight > 0 &&
    locationY >= -1 &&
    locationY <= bubbleHeight + 1
  ) {
    return pressWindowY - locationY + bubbleHeight / 2;
  }
  return pressWindowY;
}

/** Visual bubble edges from a press on the same view as Yoga `onLayout.height`. */
export function bubbleVisualEdgesFromPress(args: {
  pressWindowY: number | null;
  locationY: number | null;
  yogaHeight: number;
}): { visualTop: number; visualBottom: number } | null {
  const { pressWindowY, locationY, yogaHeight } = args;
  if (pressWindowY == null || locationY == null || yogaHeight <= 0) return null;
  if (locationY < -1 || locationY > yogaHeight + 1) return null;
  const visualTop = pressWindowY - locationY;
  return { visualTop, visualBottom: visualTop + yogaHeight };
}

export function bubbleAnchorFromPress(
  event: unknown,
  yogaHeight: number,
  captured?: MenuPressCoords | null,
): BubbleAnchorRect {
  const coords = readMenuPressCoords(event);
  const pressWindowY = coords?.windowY ?? captured?.windowY ?? null;
  const locationY = coords?.locationY ?? captured?.locationY ?? null;
  const edges = bubbleVisualEdgesFromPress({
    pressWindowY,
    locationY,
    yogaHeight,
  });
  const originY =
    edges != null
      ? (edges.visualTop + edges.visualBottom) / 2
      : visualMenuOriginY({
          pressWindowY,
          locationY,
          bubbleHeight: yogaHeight,
          fallbackY: pressWindowY ?? 0,
        });
  return {
    left: 0,
    right: 0,
    top: edges?.visualTop ?? 0,
    bottom: edges?.visualBottom ?? 0,
    originY,
    visualTop: edges?.visualTop ?? null,
    visualBottom: edges?.visualBottom ?? null,
    yogaHeight,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Native `measure` / `measureInWindow` can report a negative width/height after
 * `scaleY: -1` (inverted chat list). Normalize to a visual top-left box.
 */
export function windowRectFromNativeMeasure(
  pageX: number,
  pageY: number,
  width: number,
  height: number,
): BubbleBoxRect {
  const w = Math.abs(width);
  const h = Math.abs(height);
  const left = width >= 0 ? pageX : pageX + width;
  const top = height >= 0 ? pageY : pageY + height;
  return {
    left,
    top,
    right: left + w,
    bottom: top + h,
  };
}

/** Window-Y band the panel must occupy: below the header, above compose. */
export function menuFeedVerticalBounds(
  feedTopY: number,
  feedBottomY: number,
  panelHeight: number,
  menuGap: number,
): { minTop: number; maxTop: number } {
  const minTop = feedTopY + menuGap;
  const maxTop = feedBottomY - menuGap - panelHeight;
  return { minTop, maxTop: Math.max(minTop, maxTop) };
}

export type MenuPlacement = "above" | "below" | "clamped";

export type MenuEdgePin =
  | { placement: "above"; menuBottomY: number }
  | { placement: "below"; menuTopY: number }
  | { placement: "clamped"; menuTopY: number };

export type VisibleMenuPosition = {
  style: ViewStyle;
  placement: MenuPlacement;
  pin: MenuEdgePin;
};

/**
 * Visual Y above the feed midpoint → menu opens below; at or below → above.
 * `visualY` must be screen-space (press / reconstructed bubble mid), not
 * inverted `measure()` of the bubble.
 */
export function resolveMenuPlacement(args: {
  visualY: number;
  feedTopY: number;
  feedBottomY: number;
}): "above" | "below" {
  const feedMid = (args.feedTopY + args.feedBottomY) / 2;
  return args.visualY < feedMid ? "below" : "above";
}

/**
 * Preferred side from feed midpoint, then the other side if the preferred
 * one does not fit. If neither fits, clamp into the feed band.
 *
 * The gap is edge-to-edge: menu bottom ↔ bubble top, or menu top ↔ bubble bottom.
 * Panel height is only for fit, not for the pin.
 */
export function resolveMenuEdgePin(args: {
  bubbleTopY: number;
  bubbleBottomY: number;
  feedTopY: number;
  feedBottomY: number;
  panelHeight: number;
  menuGap: number;
  minTop: number;
  maxTop: number;
}): MenuEdgePin {
  const {
    bubbleTopY,
    bubbleBottomY,
    feedTopY,
    feedBottomY,
    panelHeight,
    menuGap,
    minTop,
    maxTop,
  } = args;
  const belowTop = bubbleBottomY + menuGap;
  const aboveTop = bubbleTopY - menuGap - panelHeight;
  const spaceBelow = feedBottomY - bubbleBottomY - menuGap;
  const spaceAbove = bubbleTopY - feedTopY - menuGap;

  const belowFits = belowTop >= minTop && belowTop <= maxTop;
  const aboveFits = aboveTop >= minTop && aboveTop <= maxTop;
  const prefer = resolveMenuPlacement({
    visualY: (bubbleTopY + bubbleBottomY) / 2,
    feedTopY,
    feedBottomY,
  });

  if (prefer === "below") {
    if (belowFits) return { placement: "below", menuTopY: belowTop };
    if (aboveFits) return { placement: "above", menuBottomY: bubbleTopY - menuGap };
  } else {
    if (aboveFits) return { placement: "above", menuBottomY: bubbleTopY - menuGap };
    if (belowFits) return { placement: "below", menuTopY: belowTop };
  }

  return {
    placement: "clamped",
    menuTopY: clamp(spaceBelow >= spaceAbove ? belowTop : aboveTop, minTop, maxTop),
  };
}

/**
 * Map a window-space edge pin onto a positioning parent.
 * `parentLayoutHeight` must be Yoga `onLayout.height` of that parent — the same
 * box `style.bottom` is resolved against. Do not mix in measureInWindow height.
 */
export function menuPinToParentStyle(
  pin: MenuEdgePin,
  parentWindowY: number,
  parentLayoutHeight: number,
): Pick<ViewStyle, "top" | "bottom"> {
  if (pin.placement === "above") {
    return { bottom: parentLayoutHeight - (pin.menuBottomY - parentWindowY) };
  }
  return { top: pin.menuTopY - parentWindowY };
}

/**
 * First paint must not wait on a measured panel height for the gap: above
 * pins the menu's bottom edge, below pins the top edge.
 */
export function resolveVisibleMenuPosition(args: {
  anchor: BubbleAnchorRect | null;
  feedTopY: number | null;
  feedBottomY: number | null;
  panelHeight: number;
  menuGap: number;
  isFromMe: boolean;
  canDelete: boolean;
  parentWindowX: number;
  parentWindowY: number;
  parentLayoutHeight: number;
}): VisibleMenuPosition | null {
  const { anchor, menuGap, isFromMe, canDelete, parentWindowX, parentWindowY, parentLayoutHeight } =
    args;
  if (!anchor || parentLayoutHeight <= 0) return null;

  const panelHeight =
    args.panelHeight > 0 ? args.panelHeight : estimateMenuPanelHeight(isFromMe, canDelete);
  const feedTopY = args.feedTopY;
  const feedBottomY = args.feedBottomY;
  const hasFeed = feedTopY != null && feedBottomY != null;
  const { minTop, maxTop } = hasFeed
    ? menuFeedVerticalBounds(feedTopY, feedBottomY, panelHeight, menuGap)
    : {
        minTop: Number.NEGATIVE_INFINITY,
        maxTop: Number.POSITIVE_INFINITY,
      };
  const pin = resolveMenuEdgePin({
    bubbleTopY: anchor.top,
    bubbleBottomY: anchor.bottom,
    feedTopY: feedTopY ?? anchor.top,
    feedBottomY: feedBottomY ?? anchor.bottom,
    panelHeight,
    menuGap,
    minTop,
    maxTop,
  });

  return {
    placement: pin.placement,
    pin,
    style: {
      left: anchor.left - parentWindowX,
      width: anchor.right - anchor.left,
      alignItems: isFromMe ? "flex-end" : "flex-start",
      ...(pin.placement === "above" ? { justifyContent: "flex-end" as const } : null),
      ...menuPinToParentStyle(pin, parentWindowY, parentLayoutHeight),
    },
  };
}
