import { Ionicons } from "@expo/vector-icons";
import type { NotificationDto } from "@flora/client-core/contracts";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AppUpdateProgressModal } from "@/components/notifications/AppUpdateProgressModal";
import { formatNotificationTimeAgoRu } from "@/lib/formatNotificationTimeAgoRu";
import {
  checkAndInstall,
  cancelInteractiveApkUpdate,
  fetchUpdateManifestFromNotificationText,
  isApkUpdaterNativeReady,
} from "@/lib/apkUpdate";
import type { ApkUpdateProgress } from "@/lib/apkUpdate/progress";
import {
  isAppUpdateNotificationInstalled,
  resolveAppUpdateReleasePageUrl,
} from "@/lib/appLinks";
import { FLORA_THEME_TOKENS } from "@flora/client-core/display";
import { floraColors, floraSpacing } from "@/lib/theme";

type NotificationRowProps = {
  item: NotificationDto;
  onPress: () => void;
};

const ICON_SIZE = floraSpacing.grid * 3;

function iconForType(type: string): keyof typeof Ionicons.glyphMap {
  if (type === "like") return "heart";
  if (type === "reply" || type === "follow") return "arrow-undo";
  if (type === "app_update") return "cloud-download-outline";
  if (type === "developer") return "globe-outline";
  return "notifications-outline";
}

function iconColorsForType(type: string) {
  if (type === "like") {
    return { bg: "rgba(249, 24, 128, 0.15)", color: "#f91880" };
  }
  if (type === "reply" || type === "follow") {
    return { bg: FLORA_THEME_TOKENS.accentGreenOverlay20, color: floraColors.greenLight };
  }
  if (type === "app_update") {
    return { bg: FLORA_THEME_TOKENS.accentGreenOverlay20, color: floraColors.greenLight };
  }
  if (type === "developer") {
    return { bg: "rgba(29, 155, 240, 0.15)", color: "#1d9bf0" };
  }
  return { bg: "rgba(255, 255, 255, 0.08)", color: "rgba(250, 250, 250, 0.7)" };
}

export function NotificationRow({ item, onPress }: NotificationRowProps) {
  const iconName = iconForType(item.type);
  const iconColors = iconColorsForType(item.type);
  const isAppUpdate = item.type === "app_update";
  const [alreadyInstalled, setAlreadyInstalled] = useState(() =>
    isAppUpdate ? isAppUpdateNotificationInstalled(item.text) : false,
  );
  const showUpdateButton = isAppUpdate && !alreadyInstalled;
  const [updating, setUpdating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<ApkUpdateProgress | null>(null);
  const mountedRef = useRef(true);
  const cancelledRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setAlreadyInstalled(
      item.type === "app_update" ? isAppUpdateNotificationInstalled(item.text) : false,
    );
  }, [item.notificationUuid, item.type, item.text]);

  const closeModal = () => {
    if (!mountedRef.current) return;
    setUpdating(false);
    setCancelling(false);
    setProgress(null);
  };

  const handleCancel = () => {
    if (cancelling) return;
    const phase = progress?.phase;
    if (phase === "error" || phase === "done") {
      closeModal();
      return;
    }
    cancelledRef.current = true;
    setCancelling(true);
    void cancelInteractiveApkUpdate()
      .catch(() => undefined)
      .finally(() => {
        closeModal();
      });
  };

  const handleUpdate = () => {
    if (updating) return;
    cancelledRef.current = false;
    setUpdating(true);
    setCancelling(false);
    setProgress({ phase: "checking" });

    const onProgress = (next: ApkUpdateProgress) => {
      if (!mountedRef.current || cancelledRef.current) return;
      setProgress(next);
    };

    void (async () => {
      try {
        if (!isApkUpdaterNativeReady()) {
          onProgress({ phase: "checking", message: "Открытие страницы релиза…" });
          await Linking.openURL(resolveAppUpdateReleasePageUrl(item.text));
          if (cancelledRef.current) return;
          onProgress({ phase: "done", message: "Страница релиза открыта" });
          return;
        }

        let result = await checkAndInstall({
          allowUserAction: true,
          force: true,
          onProgress,
        });
        if (cancelledRef.current || (result.ok && result.status === "cancelled")) {
          closeModal();
          return;
        }
        if (!result.ok && (result.code === "NO_MANIFEST" || result.code === "GITHUB")) {
          const fallback = await fetchUpdateManifestFromNotificationText(item.text).catch(
            () => null,
          );
          if (fallback) {
            onProgress({ phase: "checking" });
            result = await checkAndInstall({
              allowUserAction: true,
              force: true,
              manifest: fallback,
              onProgress,
            });
          }
        }

        if (cancelledRef.current || (result.ok && result.status === "cancelled")) {
          closeModal();
          return;
        }

        if (!result.ok) {
          onProgress({
            phase: "error",
            message: result.error || "Не удалось обновить приложение",
            code: result.code,
          });
          return;
        }

        if (result.status === "up_to_date" || result.status === "installed") {
          closeModal();
          if (mountedRef.current) setAlreadyInstalled(true);
          return;
        }

        // System installer UI — dismiss our progress sheet.
        if (result.status === "pending_user_action") {
          closeModal();
        }
      } catch (err: unknown) {
        if (cancelledRef.current) {
          closeModal();
          return;
        }
        const detail =
          err instanceof Error && err.message ? err.message : "Не удалось запустить обновление";
        onProgress({ phase: "error", message: detail });
      }
    })();
  };

  return (
    <View style={styles.shell}>
      <Pressable
        style={({ pressed }) => [
          styles.item,
          !item.isRead && styles.itemUnread,
          pressed && styles.itemPressed,
        ]}
        onPress={onPress}
        accessibilityRole="button"
      >
        <View style={[styles.iconWrap, { backgroundColor: iconColors.bg }]}>
          <Ionicons name={iconName} size={20} color={iconColors.color} />
        </View>
        <View style={styles.body}>
          <Text style={[styles.text, !item.isRead && styles.textUnread]} numberOfLines={2}>
            {item.text}
          </Text>
          <Text style={styles.time}>{formatNotificationTimeAgoRu(item.createdAt)}</Text>
        </View>
      </Pressable>
      {isAppUpdate && alreadyInstalled ? (
        <Text style={styles.updatedLabel} accessibilityRole="text">
          Обновлено
        </Text>
      ) : null}
      {showUpdateButton ? (
        <Pressable
          style={({ pressed }) => [styles.updateBtn, pressed && styles.itemPressed]}
          onPress={handleUpdate}
          disabled={updating}
          accessibilityRole="button"
          accessibilityLabel="Обновить приложение"
        >
          {updating ? (
            <ActivityIndicator color={floraColors.bg} size="small" />
          ) : (
            <Text style={styles.updateBtnText}>Обновить</Text>
          )}
        </Pressable>
      ) : null}
      {showUpdateButton ? (
        <AppUpdateProgressModal
          visible={updating}
          progress={progress}
          onClose={closeModal}
          onCancel={handleCancel}
          cancelling={cancelling}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    borderBottomColor: "rgba(250, 250, 250, 0.06)",
    borderBottomWidth: 1,
  },
  item: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    gap: floraSpacing.grid,
    paddingTop: floraSpacing.grid * 2 - 1,
    paddingBottom: floraSpacing.grid * 2 - 2,
    paddingLeft: floraSpacing.grid,
    paddingRight: floraSpacing.gridFine,
  },
  itemPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.04)",
  },
  itemUnread: {
    backgroundColor: "rgba(164, 209, 138, 0.06)",
  },
  iconWrap: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: ICON_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: floraSpacing.gridFine,
  },
  text: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  textUnread: {
    fontWeight: "500",
    color: floraColors.whiteTemplate,
  },
  time: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  updateBtn: {
    flexShrink: 0,
    marginRight: floraSpacing.grid,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    borderRadius: 9999,
    backgroundColor: floraColors.greenLight,
    minWidth: 88,
    alignItems: "center",
    justifyContent: "center",
  },
  updateBtnText: {
    color: floraColors.bg,
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.39,
  },
  updatedLabel: {
    flexShrink: 0,
    marginRight: floraSpacing.grid,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    minWidth: 88,
    textAlign: "center",
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.39,
  },
});
