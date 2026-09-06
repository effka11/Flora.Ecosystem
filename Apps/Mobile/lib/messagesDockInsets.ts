import { Platform } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import { floraMessages, floraSpacing } from "@/lib/theme";
import { liveGridRecord } from "@/lib/floraGridRuntime";

/** shell paddingTop + border + field min + shell paddingBottomExtra (without system nav). */
export function COMPOSE_BASELINE_FALLBACK_PX() {
  return floraMessages.composeShellPaddingTop +
  1 +
  floraMessages.composeFieldMinHeight +
  floraMessages.composeShellPaddingBottomExtra;
}

/** Scroll distance from end treated as "at bottom" (jump btn + atBottomRef). */
export function CHAT_AT_BOTTOM_THRESHOLD_PX() {
  return floraSpacing.grid * 2;
}

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
 * Android KSV opened offset. 0 = v3 Samsung. Step 2: composeShellPaddingKeyboard if gap > ~18px on a profile.
 * Re-QA profile 1 (Samsung) after changing 0 → 15. Do not use +navInset.
 */
export const ANDROID_KSV_OPENED_OFFSET_PX = 0;

/**
 * KSV closed/opened offsets — Android: nav at idle via translateY (shell has no nav padding).
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
    opened: ANDROID_KSV_OPENED_OFFSET_PX,
  };
}

/** Защита от floating/split-клавиатур: панель не может быть ниже этого. */
export const EMOJI_PANEL_MIN_PX = 180;

/** Панель не выше 55% окна (защита от мусорных значений высоты IME). */
export const EMOJI_PANEL_MAX_WINDOW_RATIO = 0.55;

/**
 * Высота панели в координатах подъёма дока.
 *
 * Подъём дока при полностью открытой клавиатуре = kbH + ksvClosed - ksvOpened
 * (Android: kbH - navInset, iOS: kbH). Чтобы поле ввода при переключении
 * клавиатура <-> эмодзи стояло на месте, панель обязана занять ровно этот подъём.
 */
export function emojiPanelDockHeightPx(
  keyboardHeightPx: number,
  ksvClosedPx: number,
  ksvOpenedPx: number,
  windowHeightPx: number,
): number {
  const raw = keyboardHeightPx + ksvClosedPx - ksvOpenedPx;
  const max = Math.round(windowHeightPx * EMOJI_PANEL_MAX_WINDOW_RATIO);
  return Math.min(Math.max(raw, EMOJI_PANEL_MIN_PX), max);
}

/** Внутренние отступы контента панели (панель = fixed-height слой в слоте дока). */
export const emojiPanelChromePadding = liveGridRecord(() => ({
  paddingTop: floraMessages.emojiPanelOuterGap,
  paddingHorizontal: floraMessages.emojiPanelOuterGap,
  paddingBottom: floraMessages.emojiPanelBottomExtra,
}));
