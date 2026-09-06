import { type ImageStyle, type TextStyle, type ViewStyle } from "react-native";
import { getFloraGridRuntime } from "@/lib/floraGridRuntime";

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

/**
 * Styles rebuilt when the Flora grid step changes.
 * Pass `() => StyleSheet.create({ ... })` so create runs after the current step is set.
 */
export function liveGridStyles<T extends NamedStyles<T>>(factory: () => T): T {
  let cachedStep = Number.NaN;
  let cachedFine = Number.NaN;
  let cached: T | undefined;

  const resolve = (): T => {
    const { step, stepFine } = getFloraGridRuntime();
    if (cached && step === cachedStep && stepFine === cachedFine) {
      return cached;
    }
    cachedStep = step;
    cachedFine = stepFine;
    cached = factory();
    return cached;
  };

  return new Proxy({} as T, {
    get(_target, prop) {
      const sheet = resolve() as unknown as Record<PropertyKey, unknown>;
      const value = sheet[prop];
      return typeof value === "function" ? (value as Function).bind(sheet) : value;
    },
    ownKeys() {
      return Reflect.ownKeys(resolve() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(resolve() as object, prop);
    },
    has(_target, prop) {
      return prop in (resolve() as object);
    }
  });
}
