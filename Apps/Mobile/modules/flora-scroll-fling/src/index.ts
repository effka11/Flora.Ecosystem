import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

type FloraScrollFlingNativeModule = {
  resumeVerticalFling(viewTag: number, velocityY: number): void;
};

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<FloraScrollFlingNativeModule>("FloraScrollFling")
    : null;

export function resumeVerticalFling(viewTag: number, velocityY: number): void {
  if (!native || viewTag <= 0 || !Number.isFinite(velocityY)) return;
  native.resumeVerticalFling(viewTag, velocityY);
}
