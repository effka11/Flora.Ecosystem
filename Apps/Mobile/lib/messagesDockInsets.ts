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
 * Nav height for KSV offsets (Android A+) and iOS compose padding.
 * Gesture Android: use reported insets.bottom; 3-button: fallback when bottom=0.
 */
export function resolveMessagesDockBottomInset(insets: EdgeInsets): number {
  if (Platform.OS === "ios") {
    return insets.bottom;
  }
  // TODO: replace with measured navigation bar height when available
  const androidNavFallbackPx = 48;
  return insets.bottom > 0 ? insets.bottom : androidNavFallbackPx;
}

/**
 * KSV closed/opened offsets — Android: nav at idle via translateY (shell has no nav padding).
 * opened: 0 = full KSV lift when IME open; tune to composeShellPaddingKeyboard (15px) if gap > ~18px.
 * Do not use opened: +navInset — over-compensates on Samsung 3-button + adjustPan.
 */
export function keyboardStickyOffsets(navInsetPx: number): {
  closed: number;
  opened: number;
} {
  if (Platform.OS === "ios") {
    return { closed: 0, opened: 0 };
  }
  return {
    closed: -navInsetPx,
    opened: 0,
  };
}

/** KCSV offset = closed dock shell height (baseline from onLayout, without nav padding on Android A+). */
export function composeKcsvOffsetPx(composeBaselinePx: number): number {
  return composeBaselinePx || COMPOSE_BASELINE_FALLBACK_PX;
}

/**
 * __DEV__ only: set true to disable KeyboardStickyView on Android and confirm resize+KSV
 * double-lift (gap should shrink if adjustResize alone positions the dock). Revert before merge.
 */
export const DEV_DISABLE_KSV_ON_ANDROID = false;

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
