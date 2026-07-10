import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { canRequestPackageInstalls, requestInstallPermission } from "flora-apk-updater";
import { InstallPermissionModal } from "@/components/apkUpdate/InstallPermissionModal";
import {
  resolveInstallPermissionPrompt,
  subscribeInstallPermissionPrompt,
} from "@/lib/apkUpdate/installPermissionPrompt";
import { markInstallPermissionDeclined, markInstallPermissionPrompted } from "@/lib/apkUpdate/permissionState";

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

/** Renders the Flora-styled install-permission modal when prompted. */
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
    markInstallPermissionDeclined();
    resolveInstallPermissionPrompt(false);
  };

  const handleDismiss = () => {
    if (busy) return;
    // Android Back is an explicit permanent opt-out, same as «Нет, спасибо».
    markInstallPermissionDeclined();
    resolveInstallPermissionPrompt(false);
  };

  const handleAllow = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        await requestInstallPermission();
        markInstallPermissionPrompted();
        await waitForReturnToForeground();
      } catch {
        // Settings failed — still mark prompted so post-login does not loop.
        markInstallPermissionPrompted();
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
