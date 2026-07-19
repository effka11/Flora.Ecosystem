import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Single app-wide reduced-motion source. Previously every post card attached
 * its own `AccessibilityInfo` listener and fired an async probe on mount; with
 * many recycled rows that is redundant work. This subscribes once and shares
 * the snapshot via `useSyncExternalStore`.
 */

let current = false;
let initialized = false;
const listeners = new Set<() => void>();
let subscription: { remove: () => void } | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function setValue(next: boolean): void {
  if (next === current) return;
  current = next;
  emit();
}

function ensureStarted(): void {
  if (initialized) return;
  initialized = true;
  void AccessibilityInfo.isReduceMotionEnabled()
    .then(setValue)
    .catch(() => undefined);
  subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setValue);
}

function subscribe(listener: () => void): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = null;
      initialized = false;
    }
  };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}
