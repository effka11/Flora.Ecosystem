import {
  canRequestPackageInstalls,
  isFloraApkUpdaterAvailable,
  setNativeAutoUpdateEnabled,
} from "flora-apk-updater";
import { mmkv } from "@/lib/mmkv";

const IN_APP_KEY = "apkUpdate.inAppUpdatesEnabled";
const AUTO_KEY = "apkUpdate.autoUpdateEnabled";
const CATCH_UP_AT_KEY = "apkUpdate.catchUpAt";

export const CATCH_UP_THROTTLE_MS = 15 * 60 * 1000;

let bootstrapped = false;

function syncNative(enabled: boolean): void {
  if (!isFloraApkUpdaterAvailable()) return;
  try {
    setNativeAutoUpdateEnabled(enabled);
  } catch {
    // Native module may be absent on Play / early boot.
  }
}

/**
 * Ensure MMKV keys exist (default false), migrate legacy auto-only ON,
 * write-through auto to native prefs.
 */
function ensureBootstrapped(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const autoRaw = mmkv.getString(AUTO_KEY);
  const inAppRaw = mmkv.getString(IN_APP_KEY);
  const hasOsPerm = (() => {
    try {
      return canRequestPackageInstalls();
    } catch {
      return false;
    }
  })();

  let auto = autoRaw === "1";
  let inApp = inAppRaw === "1";

  // Legacy: auto ON without inApp key → migrate.
  if (auto && inAppRaw !== "0" && inAppRaw !== "1") {
    if (hasOsPerm) {
      inApp = true;
    } else {
      auto = false;
    }
  }

  // Auto without inApp or OS perm is invalid.
  if (auto && (!inApp || !hasOsPerm)) {
    auto = false;
  }

  mmkv.set(IN_APP_KEY, inApp ? "1" : "0");
  mmkv.set(AUTO_KEY, auto ? "1" : "0");
  syncNative(auto);
}

/** Opt-in for in-app PackageInstaller (prerequisite for background). */
export function isInAppUpdatesEnabled(): boolean {
  ensureBootstrapped();
  return mmkv.getString(IN_APP_KEY) === "1";
}

export function setInAppUpdatesEnabled(enabled: boolean): void {
  ensureBootstrapped();
  mmkv.set(IN_APP_KEY, enabled ? "1" : "0");
  if (!enabled) {
    mmkv.set(AUTO_KEY, "0");
    syncNative(false);
  }
}

/** Background auto-update preference (native write-through). */
export function isAutoUpdateEnabled(): boolean {
  ensureBootstrapped();
  return mmkv.getString(AUTO_KEY) === "1";
}

/**
 * Enable background only when in-app opt-in + OS install permission.
 * Otherwise no-op (keeps OFF).
 */
export function setAutoUpdateEnabled(enabled: boolean): void {
  ensureBootstrapped();
  if (enabled) {
    if (mmkv.getString(IN_APP_KEY) !== "1") {
      mmkv.set(AUTO_KEY, "0");
      syncNative(false);
      return;
    }
    let hasOs = false;
    try {
      hasOs = canRequestPackageInstalls();
    } catch {
      hasOs = false;
    }
    if (!hasOs) {
      mmkv.set(AUTO_KEY, "0");
      syncNative(false);
      return;
    }
    mmkv.set(AUTO_KEY, "1");
    syncNative(true);
    return;
  }
  mmkv.set(AUTO_KEY, "0");
  syncNative(false);
}

export function getCatchUpAt(): number {
  return Number(mmkv.getString(CATCH_UP_AT_KEY) ?? "0") || 0;
}

export function markCatchUpAt(at = Date.now()): void {
  mmkv.set(CATCH_UP_AT_KEY, String(at));
}
