import { useEffect, useState } from "react";
import {
  canRequestPackageInstalls,
  openInstallPermissionSettings,
} from "flora-apk-updater";
import { InstallPermissionModal } from "@/components/apkUpdate/InstallPermissionModal";
import { reconcileInstallPermissionWithOs } from "@/lib/apkUpdate/autoUpdatePreference";
import {
  resolveInstallPermissionPrompt,
  subscribeInstallPermissionPrompt,
} from "@/lib/apkUpdate/installPermissionPrompt";
import { waitForInstallPermissionResult } from "@/lib/apkUpdate/waitForInstallPermission";

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

  const finishWithLive = () => {
    const { hasOs } = reconcileInstallPermissionWithOs();
    resolveInstallPermissionPrompt(hasOs);
  };

  /** Decline / dismiss without Settings — always resolve false; reconcile may clear inApp if OS off. */
  const finishDeclined = () => {
    reconcileInstallPermissionWithOs();
    resolveInstallPermissionPrompt(false);
  };

  const handleDecline = () => {
    if (busy) return;
    finishDeclined();
  };

  const handleDismiss = () => {
    if (busy) return;
    finishDeclined();
  };

  const handleAllow = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        if (canRequestPackageInstalls()) {
          finishWithLive();
          return;
        }
        const opened = await openInstallPermissionSettings();
        if (opened) {
          await waitForInstallPermissionResult({ mode: "grant" });
        }
        finishWithLive();
      } catch {
        finishWithLive();
      }
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
