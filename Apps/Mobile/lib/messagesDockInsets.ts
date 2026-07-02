import { Platform } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import { floraMessages, floraSpacing } from "@/lib/theme";

/** shell paddingTop + border + field min + shell paddingBottomExtra (without system nav). */
export const COMPOSE_BASELINE_FALLBACK_PX =
  floraMessages.composeShellPaddingTop +
  1 +
  floraMessages.composeFieldMinHeight +
  floraMessages.composeShellPaddingBottomExtra;

/** Scroll distance from end treated as "at bottom" (jump btn + atBottomRef). */
export const CHAT_AT_BOTTOM_THRESHOLD_PX = floraSpacing.grid * 2;

/**
 * Bottom inset for thread compose dock (system nav on 3-button Android).
 * Phase 1: max(safe area, Android fallback). Calibrate per OEM after visual QA.
 */
export function resolveMessagesDockBottomInset(insets: EdgeInsets): number {
  if (Platform.OS === "ios") {
    return insets.bottom;
  }
  // TODO: replace with measured navigation bar height when available
  const androidNavFallbackPx = 48;
  return Math.max(insets.bottom, androidNavFallbackPx);
}

/**
 * KCSV offset = closed dock height. Baseline from onLayout includes compose bottomInset (nav).
 * Before first layout, add navInsetFallback to shell fallback.
 */
export function composeKcsvOffsetPx(
  composeBaselinePx: number,
  navInsetFallback: number,
): number {
  return composeBaselinePx || COMPOSE_BASELINE_FALLBACK_PX + navInsetFallback;
}

/** KSV offset.closed — nav lives in compose padding, not translateY. */
export const KEYBOARD_STICKY_CLOSED_OFFSET_PX = 0;

/** KSV offset.opened — 15px gap between pill and IME (T3). */
export const KEYBOARD_STICKY_OPENED_OFFSET_PX = floraMessages.composeShellPaddingKeyboard;

/**
 * Animated emoji slot outer height: gap above panel + panel + gap below.
 * Padding on the slot view must match {@link emojiPanelChromePadding}.
 */
export function emojiSlotTargetHeight(panelHeightPx: number): number {
  return (
    panelHeightPx +
    floraMessages.emojiPanelOuterGap +
    floraMessages.emojiPanelBottomExtra
  );
}

/** Padding inside emoji slot / OverKeyboard panel — must match emojiSlotTargetHeight formula. */
export const emojiPanelChromePadding = {
  paddingTop: floraMessages.emojiPanelOuterGap,
  paddingHorizontal: floraMessages.emojiPanelOuterGap,
  paddingBottom: floraMessages.emojiPanelBottomExtra,
} as const;
