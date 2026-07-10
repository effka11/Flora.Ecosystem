import { Ionicons } from "@expo/vector-icons";
import { requestInstallPermission } from "flora-apk-updater";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from "react-native";
import {
  labelForApkUpdatePhase,
  type ApkUpdateProgress,
} from "@/lib/apkUpdate/progress";
import { floraColors, floraSpacing } from "@/lib/theme";

const INSTALL_PERMISSION_MESSAGE = "Нужно разрешить установку из этого источника";

type Props = {
  visible: boolean;
  progress: ApkUpdateProgress | null;
  /** Dismiss after error/done (no cancel). */
  onClose: () => void;
  /** Stop update, clear pending APK cache, dismiss. */
  onCancel: () => void;
  cancelling?: boolean;
};

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

function isInstallPermissionError(progress: ApkUpdateProgress | null): boolean {
  if (!progress || progress.phase !== "error") return false;
  if (progress.code === "NO_PERMISSION") return true;
  return (progress.message?.trim() ?? "") === INSTALL_PERMISSION_MESSAGE;
}

export function AppUpdateProgressModal({
  visible,
  progress,
  onClose,
  onCancel,
  cancelling = false,
}: Props) {
  const [permissionBusy, setPermissionBusy] = useState(false);
  const phase = progress?.phase ?? "checking";
  const isError = phase === "error";
  const isDone = phase === "done";
  const canDismiss = isError || isDone;
  const needsInstallPermission = isInstallPermissionError(progress);
  // PackageInstaller has no cancellation handle after its session is committed.
  const canCancel = !canDismiss && phase !== "installing";
  const title = progress?.message?.trim()
    ? progress.message
    : labelForApkUpdatePhase(phase);
  const fraction = progress?.fraction;
  const showBar = phase === "downloading";
  const pct =
    showBar && fraction != null && Number.isFinite(fraction)
      ? Math.min(100, Math.max(0, Math.round(fraction * 100)))
      : null;

  useEffect(() => {
    if (!visible || !needsInstallPermission) setPermissionBusy(false);
  }, [needsInstallPermission, visible]);

  const handleRequestClose = () => {
    if (cancelling || permissionBusy) return;
    if (canDismiss) onClose();
    else if (canCancel) onCancel();
  };

  const handleAllowInstall = () => {
    if (permissionBusy || cancelling) return;
    setPermissionBusy(true);
    void (async () => {
      try {
        await requestInstallPermission();
        await waitForReturnToForeground();
      } catch {
        /* settings may fail — still dismiss so user can retry update */
      }
      setPermissionBusy(false);
      onClose();
    })();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleRequestClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          {canDismiss || canCancel ? (
            <Pressable
              style={({ pressed }) => [styles.xBtn, pressed && styles.xBtnPressed]}
              onPress={handleRequestClose}
              disabled={cancelling || permissionBusy}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={canDismiss ? "Закрыть" : "Отменить обновление"}
            >
              <Ionicons name="close" size={22} color={floraColors.gray} />
            </Pressable>
          ) : null}

          <View style={styles.iconWrap}>
            {cancelling || permissionBusy ? (
              <ActivityIndicator color={floraColors.greenLight} size="large" />
            ) : isError ? (
              <Ionicons name="alert-circle-outline" size={28} color={floraColors.error} />
            ) : isDone ? (
              <Ionicons name="checkmark-circle-outline" size={28} color={floraColors.greenLight} />
            ) : (
              <ActivityIndicator color={floraColors.greenLight} size="large" />
            )}
          </View>

          <Text style={styles.title}>
            {cancelling ? "Отмена…" : permissionBusy ? "Открываем настройки…" : title}
          </Text>

          {showBar && !cancelling && !permissionBusy ? (
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.barFill,
                  { width: pct != null ? `${pct}%` : "18%" },
                  pct == null && styles.barIndeterminate,
                ]}
              />
            </View>
          ) : null}

          {pct != null && !cancelling && !permissionBusy ? (
            <Text style={styles.pct}>{pct}%</Text>
          ) : null}

          {canDismiss && !cancelling ? (
            needsInstallPermission ? (
              <View style={styles.actions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.closeBtn,
                    styles.allowBtn,
                    (pressed || permissionBusy) && styles.closeBtnPressed,
                    permissionBusy && styles.btnDisabled,
                  ]}
                  onPress={handleAllowInstall}
                  disabled={permissionBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Разрешить"
                >
                  <Text style={styles.closeBtnText}>
                    {permissionBusy ? "Открываем настройки…" : "Разрешить"}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    pressed && !permissionBusy && styles.closeBtnPressed,
                  ]}
                  onPress={onClose}
                  disabled={permissionBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Закрыть"
                >
                  <Text style={styles.secondaryBtnText}>Закрыть</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Закрыть"
              >
                <Text style={styles.closeBtnText}>Закрыть</Text>
              </Pressable>
            )
          ) : !cancelling && !canCancel ? (
            <Text style={styles.hint}>Установка передана системе</Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: floraSpacing.grid * 2,
  },
  card: {
    width: "100%",
    maxWidth: 320,
    borderRadius: floraSpacing.grid,
    backgroundColor: floraColors.surfaceElevated,
    borderWidth: 1,
    borderColor: floraColors.border,
    paddingHorizontal: floraSpacing.grid * 2,
    paddingTop: floraSpacing.grid * 2 + floraSpacing.gridFine,
    paddingBottom: floraSpacing.grid * 2 - floraSpacing.gridFine,
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  xBtn: {
    position: "absolute",
    top: floraSpacing.gridFine * 2,
    right: floraSpacing.gridFine * 2,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  xBtnPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.08)",
  },
  iconWrap: {
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 16,
    fontWeight: "400",
    letterSpacing: 0.32,
    textAlign: "center",
    lineHeight: 22,
  },
  barTrack: {
    width: "100%",
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(250, 250, 250, 0.08)",
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: floraColors.greenLight,
  },
  barIndeterminate: {
    opacity: 0.7,
  },
  pct: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  hint: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
    textAlign: "center",
  },
  actions: {
    width: "100%",
    alignItems: "center",
    gap: floraSpacing.gridFine,
  },
  closeBtn: {
    marginTop: floraSpacing.gridFine,
    paddingHorizontal: floraSpacing.grid * 2,
    paddingVertical: floraSpacing.gridFine * 2,
    borderRadius: 9999,
    backgroundColor: floraColors.greenLight,
    minWidth: 120,
    alignItems: "center",
  },
  allowBtn: {
    width: "100%",
    marginTop: floraSpacing.gridFine,
  },
  closeBtnPressed: {
    opacity: 0.85,
  },
  btnDisabled: {
    opacity: 0.7,
  },
  closeBtnText: {
    color: floraColors.bg,
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
  },
  secondaryBtn: {
    width: "100%",
    paddingVertical: floraSpacing.gridFine * 2,
    borderRadius: 9999,
    alignItems: "center",
  },
  secondaryBtnText: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
});
