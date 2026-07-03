import { Dimensions } from "react-native";
import { mmkv } from "@/lib/mmkv";

export const MESSAGES_IME_HEIGHT_MMKV_KEY = "messagesImeHeightPx";
export const LEGACY_KEYBOARD_HEIGHT_MMKV_KEY = "keyboardHeightPx";

const KB_HEIGHT_EPSILON_PX = 2;
const BOOTSTRAP_IME_HEIGHT_RATIO = 0.38;

function sanitizeKbHeightPx(h: number): number {
  return Math.max(0, h);
}

function readStoredHeight(key: string): number {
  const raw = mmkv.getNumber(key);
  if (raw == null || !Number.isFinite(raw)) return 0;
  return sanitizeKbHeightPx(raw);
}

/** Migrate legacy `keyboardHeightPx` → `messagesImeHeightPx` once. */
export function migrateLegacyImeHeight(): void {
  const current = readStoredHeight(MESSAGES_IME_HEIGHT_MMKV_KEY);
  if (current > KB_HEIGHT_EPSILON_PX) return;

  const legacy = readStoredHeight(LEGACY_KEYBOARD_HEIGHT_MMKV_KEY);
  if (legacy > KB_HEIGHT_EPSILON_PX) {
    mmkv.set(MESSAGES_IME_HEIGHT_MMKV_KEY, legacy);
  }
  mmkv.delete(LEGACY_KEYBOARD_HEIGHT_MMKV_KEY);
}

export function getCachedImeHeightPx(): number {
  return readStoredHeight(MESSAGES_IME_HEIGHT_MMKV_KEY);
}

export function getBootstrapImeHeightPx(): number {
  return Math.round(Dimensions.get("window").height * BOOTSTRAP_IME_HEIGHT_RATIO);
}

/** Idempotent MMKV write — skip only when delta within epsilon (large jumps always persist). */
export function commitImeHeightPx(h: number): void {
  const px = sanitizeKbHeightPx(h);
  if (px <= KB_HEIGHT_EPSILON_PX) return;

  const prev = getCachedImeHeightPx();
  const delta = Math.abs(px - prev);
  if (delta <= KB_HEIGHT_EPSILON_PX) return;

  mmkv.set(MESSAGES_IME_HEIGHT_MMKV_KEY, px);
}
