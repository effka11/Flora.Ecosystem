import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

type FloraScrollFlingNativeModule = {
  resumeVerticalFling(viewTag: number, velocityY: number): void;
  /** Опциональные: есть только после rebuild APK с обновлённым Kotlin-модулем. */
  cancelTouchAndResumeVerticalFling?(viewTag: number, velocityY: number): void;
  ensureVerticalFlingAlive?(viewTag: number, velocityY: number): void;
  installEdgeFlingGuard?(viewTag: number, edgeWidthDp: number, verticalSlopDp: number): void;
  uninstallEdgeFlingGuard?(viewTag: number): void;
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
 * и продолжает вертикальную инерцию нативным fling. Скорость берётся из
 * нативного трекера; velocityY (dp/s) — fallback.
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

/**
 * Страховка при открытии меню без касания ленты (тап по гамбургеру):
 * нативная отложенная проверка — если coast умер, fling перезапускается;
 * если лента едет, вызов ничего не меняет.
 */
export function ensureVerticalFlingAlive(viewTag: number, velocityY: number): void {
  if (!native || viewTag <= 0 || !Number.isFinite(velocityY)) return;
  if (typeof native.ensureVerticalFlingAlive === "function") {
    // TODO(edge-debug): временная диагностика, убрать после проверки.
    console.log(`[edge-guard] ensure fling alive tag=${viewTag} vel=${Math.round(velocityY)}`);
    native.ensureVerticalFlingAlive(viewTag, velocityY);
  }
}

/**
 * Нативный edge-guard: пока лента летит (fling), касание в левой полосе
 * edgeWidthDp проглатывается до onTouchEvent ScrollView — ACTION_DOWN не
 * останавливает fling, палец не влияет на ленту, CANCEL активации drawer-а
 * не гасит инерцию. Вертикальный сдвиг > verticalSlopDp отдаёт жест ленте
 * (нативная «поимка» пальцем сохраняется).
 */
export function installEdgeFlingGuard(
  viewTag: number,
  edgeWidthDp: number,
  verticalSlopDp: number,
): void {
  if (!native || viewTag <= 0) return;
  native.installEdgeFlingGuard?.(viewTag, edgeWidthDp, verticalSlopDp);
}

export function uninstallEdgeFlingGuard(viewTag: number): void {
  if (!native || viewTag <= 0) return;
  native.uninstallEdgeFlingGuard?.(viewTag);
}

