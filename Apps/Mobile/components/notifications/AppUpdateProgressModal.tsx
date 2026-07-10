import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import {
  labelForApkUpdatePhase,
  type ApkUpdateProgress,
} from "@/lib/apkUpdate/progress";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  visible: boolean;
  progress: ApkUpdateProgress | null;
  /** Dismiss after error/done (no cancel). */
  onClose: () => void;
  /** Stop update, clear pending APK cache, dismiss. */
  onCancel: () => void;
  cancelling?: boolean;
};

export function AppUpdateProgressModal({
  visible,
  progress,
  onClose,
  onCancel,
  cancelling = false,
}: Props) {
  const phase = progress?.phase ?? "checking";
  const isError = phase === "error";
  const isDone = phase === "done";
  const canDismiss = isError || isDone;
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

  const handleRequestClose = () => {
    if (cancelling) return;
    if (canDismiss) onClose();
    else if (canCancel) onCancel();
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
              disabled={cancelling}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={canDismiss ? "Закрыть" : "Отменить обновление"}
            >
              <Ionicons name="close" size={22} color={floraColors.gray} />
            </Pressable>
          ) : null}

          <View style={styles.iconWrap}>
            {cancelling ? (
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
            {cancelling ? "Отмена…" : title}
          </Text>

          {showBar && !cancelling ? (
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

          {pct != null && !cancelling ? <Text style={styles.pct}>{pct}%</Text> : null}

          {canDismiss && !cancelling ? (
            <Pressable
              style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
            >
              <Text style={styles.closeBtnText}>Закрыть</Text>
            </Pressable>
          ) : !cancelling ? (
            <Text style={styles.hint}>
              {canCancel ? "Можно отменить крестиком" : "Установка передана системе"}
            </Text>
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
  closeBtn: {
    marginTop: floraSpacing.gridFine,
    paddingHorizontal: floraSpacing.grid * 2,
    paddingVertical: floraSpacing.gridFine * 2,
    borderRadius: 9999,
    backgroundColor: floraColors.greenLight,
    minWidth: 120,
    alignItems: "center",
  },
  closeBtnPressed: {
    opacity: 0.85,
  },
  closeBtnText: {
    color: floraColors.bg,
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
  },
});
