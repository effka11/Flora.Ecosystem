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

type PrefListener = () => void;
const prefListeners = new Set<PrefListener>();

function notifyPrefListeners(): void {
  for (const listener of prefListeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

/** Subscribe to inApp / auto preference writes (settings Switch refresh). */
export function subscribeUpdatePreferences(listener: PrefListener): () => void {
  prefListeners.add(listener);
  return () => {
    prefListeners.delete(listener);
  };
}

function syncNative(enabled: boolean): void {
  if (!isFloraApkUpdaterAvailable()) return;
  try {
    setNativeAutoUpdateEnabled(enabled);
  } catch {
    // Native module may be absent on Play / early boot.
  }
}

function readOsInstallPermission(): boolean {
  try {
    return canRequestPackageInstalls();
  } catch {
    return false;
  }
}

/**
 * Ensure MMKV keys exist (default false), migrate legacy auto-only ON,
 * write-through auto to native prefs. Runs once; then call
 * {@link reconcileInstallPermissionWithOs} on every AppState active.
 */
function ensureBootstrapped(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const autoRaw = mmkv.getString(AUTO_KEY);
  const inAppRaw = mmkv.getString(IN_APP_KEY);
  const hasOsPerm = readOsInstallPermission();

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

  // Mirror OS install permission onto inApp.
  inApp = hasOsPerm;

  // Auto without inApp or OS perm is invalid.
  if (auto && (!inApp || !hasOsPerm)) {
    auto = false;
  }

  mmkv.set(IN_APP_KEY, inApp ? "1" : "0");
  mmkv.set(AUTO_KEY, auto ? "1" : "0");
  syncNative(auto);
}

/**
 * Align MMKV (+ native auto) with live OS install permission.
 * Full mirror: hasOs ⇔ inApp. Auto forced OFF when OS revoked.
 */
export function reconcileInstallPermissionWithOs(): {
  hasOs: boolean;
  inApp: boolean;
  auto: boolean;
} {
  ensureBootstrapped();
  const hasOs = readOsInstallPermission();
  const prevInApp = mmkv.getString(IN_APP_KEY) === "1";
  const prevAuto = mmkv.getString(AUTO_KEY) === "1";

  let inApp = hasOs;
  let auto = prevAuto;

  if (!hasOs) {
    auto = false;
  } else if (auto && !inApp) {
    auto = false;
  }

  const changed = prevInApp !== inApp || prevAuto !== auto;
  mmkv.set(IN_APP_KEY, inApp ? "1" : "0");
  mmkv.set(AUTO_KEY, auto ? "1" : "0");
  syncNative(auto);
  if (changed) {
    notifyPrefListeners();
  }

  return { hasOs, inApp, auto };
}

/** Mirrors OS install permission (kept in sync by reconcile). */
export function isInAppUpdatesEnabled(): boolean {
  ensureBootstrapped();
  return mmkv.getString(IN_APP_KEY) === "1";
}

export function setInAppUpdatesEnabled(enabled: boolean): void {
  ensureBootstrapped();
  const next = enabled ? "1" : "0";
  const prev = mmkv.getString(IN_APP_KEY);
  mmkv.set(IN_APP_KEY, next);
  if (!enabled) {
    mmkv.set(AUTO_KEY, "0");
    syncNative(false);
  }
  if (prev !== next || !enabled) {
    notifyPrefListeners();
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
      notifyPrefListeners();
      return;
    }
    if (!readOsInstallPermission()) {
      mmkv.set(AUTO_KEY, "0");
      syncNative(false);
      notifyPrefListeners();
      return;
    }
    mmkv.set(AUTO_KEY, "1");
    syncNative(true);
    notifyPrefListeners();
    return;
  }
  mmkv.set(AUTO_KEY, "0");
  syncNative(false);
  notifyPrefListeners();
}

export function getCatchUpAt(): number {
  return Number(mmkv.getString(CATCH_UP_AT_KEY) ?? "0") || 0;
}

export function markCatchUpAt(at = Date.now()): void {
  mmkv.set(CATCH_UP_AT_KEY, String(at));
}
