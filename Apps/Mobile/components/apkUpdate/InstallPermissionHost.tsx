import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { canRequestPackageInstalls, requestInstallPermission } from "flora-apk-updater";
import { InstallPermissionModal } from "@/components/apkUpdate/InstallPermissionModal";
import {
  resolveInstallPermissionPrompt,
  subscribeInstallPermissionPrompt,
} from "@/lib/apkUpdate/installPermissionPrompt";

function waitForReturnToForeground(timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve) => {
    let left = AppState.currentState !== "active";
    const done = () => {
      clearTimeout(timer);
      sub.remove();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next !== "active") {
        left = true;
        return;
      }
      if (left) done();
    });
  });
}

/**
 * App-wide host for the install-permission sheet (sideload). Mount once from FloraProviders.
 */
export function InstallPermissionHost() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return subscribeInstallPermissionPrompt((next) => {
      setVisible(next);
      if (!next) setBusy(false);
    });
  }, []);

  const handleDecline = () => {
    if (busy) return;
    resolveInstallPermissionPrompt(false);
  };

  const handleDismiss = () => {
    if (busy) return;
    resolveInstallPermissionPrompt(false);
  };

  const handleAllow = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        await requestInstallPermission();
        await waitForReturnToForeground();
      } catch {
        // Settings failed — still resolve with live check.
      }
      resolveInstallPermissionPrompt(canRequestPackageInstalls());
    })();
  };

  return (
    <InstallPermissionModal
      visible={visible}
      busy={busy}
      onDismiss={handleDismiss}
      onDecline={handleDecline}
      onAllow={handleAllow}
    />
  );
}
