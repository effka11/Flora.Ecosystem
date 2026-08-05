import {
  isFloraApkUpdaterAvailable,
  setNativeAutoUpdateEnabled,
} from "flora-apk-updater";
import { mmkv } from "@/lib/mmkv";

const KEY = "apkUpdate.autoUpdateEnabled";

let bootstrapped = false;

/**
 * Ensure MMKV key exists (default false) and write-through to native prefs
 * so FCM cannot see a phantom ON after MMKV wipe.
 */
function ensureBootstrapped(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  const raw = mmkv.getString(KEY);
  if (raw === "0" || raw === "1") {
    syncNative(raw === "1");
    return;
  }
  mmkv.set(KEY, "0");
  syncNative(false);
}

function syncNative(enabled: boolean): void {
  if (!isFloraApkUpdaterAvailable()) return;
  try {
    setNativeAutoUpdateEnabled(enabled);
  } catch {
    // Native module may be absent on Play / early boot.
  }
}

/** UI / JS SoT — MMKV. Native mirror is write-through only. */
export function isAutoUpdateEnabled(): boolean {
  ensureBootstrapped();
  return mmkv.getString(KEY) === "1";
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  bootstrapped = true;
  mmkv.set(KEY, enabled ? "1" : "0");
  syncNative(enabled);
}
