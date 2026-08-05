import { AppState, type AppStateStatus } from "react-native";
import { canRequestPackageInstalls } from "flora-apk-updater";

export type InstallPermissionWaitMode = "grant" | "revoke";

/**
 * After opening OS install-permission settings: wait, then resolve with live check.
 *
 * - `grant`: early-exit if already granted; poll until granted or return to foreground.
 * - `revoke`: return-only — never early-exit; wait background→active (or timeout), then live check.
 */
export function waitForInstallPermissionResult(options?: {
  mode?: InstallPermissionWaitMode;
  timeoutMs?: number;
  pollMs?: number;
  graceMs?: number;
}): Promise<boolean> {
  const mode: InstallPermissionWaitMode = options?.mode ?? "grant";
  const timeoutMs = options?.timeoutMs ?? 90_000;
  const pollMs = options?.pollMs ?? 400;
  const graceMs = options?.graceMs ?? 500;

  return new Promise((resolve) => {
    let settled = false;
    let leftForeground = AppState.currentState !== "active";

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(graceTimer);
      if (poll != null) clearInterval(poll);
      sub.remove();
      try {
        resolve(canRequestPackageInstalls());
      } catch {
        resolve(false);
      }
    };

    if (mode === "grant") {
      try {
        if (canRequestPackageInstalls()) {
          finish();
          return;
        }
      } catch {
        // continue waiting
      }
    }

    const timeout = setTimeout(finish, timeoutMs);

    const poll =
      mode === "grant"
        ? setInterval(() => {
            try {
              if (canRequestPackageInstalls()) finish();
            } catch {
              // ignore
            }
          }, pollMs)
        : null;

    const graceTimer = setTimeout(() => {
      if (mode === "grant") {
        try {
          if (canRequestPackageInstalls()) finish();
        } catch {
          // ignore
        }
      }
      // revoke: ignore grace — only return-from-background or timeout.
    }, graceMs);

    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next !== "active") {
        leftForeground = true;
        return;
      }
      if (leftForeground) finish();
    });
  });
}
