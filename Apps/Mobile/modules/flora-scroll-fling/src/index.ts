import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

type FloraScrollFlingNativeModule = {
  resumeVerticalFling(viewTag: number, velocityY: number): void;
  /** Есть только после rebuild APK с обновлённым Kotlin-модулем. */
  cancelTouchAndResumeVerticalFling?(viewTag: number, velocityY: number): void;
};

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<FloraScrollFlingNativeModule>("FloraScrollFling")
    : null;

export function resumeVerticalFling(viewTag: number, velocityY: number): void {
  if (!native || viewTag <= 0 || !Number.isFinite(velocityY)) return;
  native.resumeVerticalFling(viewTag, velocityY);
}

/**
 * Отцепляет текущее касание от ScrollView (синтетический ACTION_CANCEL)
 * и продолжает вертикальную инерцию нативным fling с заданной скоростью.
 * До native rebuild падает на resumeVerticalFling (без cancel).
 */
export function cancelTouchAndResumeVerticalFling(
  viewTag: number,
  velocityY: number,
): void {
  if (!native || viewTag <= 0 || !Number.isFinite(velocityY)) return;
  if (typeof native.cancelTouchAndResumeVerticalFling === "function") {
    // TODO(edge-debug): временная диагностика, убрать после проверки.
    console.log(`[edge-guard] native cancel+fling tag=${viewTag} vel=${Math.round(velocityY)}`);
    native.cancelTouchAndResumeVerticalFling(viewTag, velocityY);
    return;
  }
  console.log("[edge-guard] fallback resumeVerticalFling (native fn missing)");
  native.resumeVerticalFling(viewTag, velocityY);
}
