import { Ionicons } from "@expo/vector-icons";
import {
  canRequestPackageInstalls,
  openInstallPermissionSettings,
} from "flora-apk-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { AppUpdateProgressModal } from "@/components/notifications/AppUpdateProgressModal";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import {
  cancelInteractiveApkUpdate,
  fetchLatestUpdateManifest,
  FLORA_APK_UPDATE_CHANNELS,
  getInstalledVersionCode,
  getUpdateChannelId,
  isAutoUpdateEnabled,
  isInAppUpdatesEnabled,
  isSideloadUpdatesEnabled,
  labelForUpdateChannel,
  openInstallPermissionPrompt,
  reconcileInstallPermissionWithOs,
  resolveInstalledBuildOfficiality,
  runAppUpdateCatchUp,
  runUserUpdateCheck,
  setAutoUpdateEnabled,
  setUpdateChannelId,
  subscribeUpdatePreferences,
  type ApkUpdateProgress,
  type AndroidUpdateManifest,
  type FloraApkUpdateChannelId,
  type InstalledBuildOfficiality,
} from "@/lib/apkUpdate";
import { waitForInstallPermissionResult } from "@/lib/apkUpdate/waitForInstallPermission";
import { FLORA_DOWNLOAD_PAGE, getFloraSocialAppVersion } from "@/lib/appLinks";
import { floraColors, floraSpacing } from "@/lib/theme";

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function matchesSearch(query: string, ...haystacks: readonly (string | null | undefined)[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return haystacks.some((item) => (item ?? "").toLowerCase().includes(q));
}

type Props = {
  searchQuery: string;
};

function ToggleCard({
  title,
  description,
  value,
  onValueChange,
  disabled,
  footer,
}: {
  title: string;
  description: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  footer?: string | null;
}) {
  return (
    <View style={[ui.listCard, disabled && ui.textActionDisabled]}>
      <View style={ui.listCardInfo}>
        <Text style={ui.listCardTitle}>{title}</Text>
        <Text style={ui.listCardDesc}>{description}</Text>
        {footer ? <Text style={ui.feedbackError}>{footer}</Text> : null}
      </View>
      <View style={ui.listCardActionCol}>
        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          trackColor={{ false: floraColors.surface, true: floraColors.accentDark }}
          thumbColor={floraColors.whiteTemplate}
        />
      </View>
    </View>
  );
}

export function UpdatesSettingsTab({ searchQuery }: Props) {
  const sideload = isSideloadUpdatesEnabled();
  const installedVersion = getFloraSocialAppVersion();
  const installedCode = getInstalledVersionCode();

  const [latest, setLatest] = useState<AndroidUpdateManifest | null>(null);
  const [latestBusy, setLatestBusy] = useState(false);
  const [officiality, setOfficiality] = useState<InstalledBuildOfficiality | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(() => isAutoUpdateEnabled());
  const [hasInstallPerm, setHasInstallPerm] = useState(() =>
    sideload ? canRequestPackageInstalls() : false,
  );
  const [permBusy, setPermBusy] = useState(false);
  const [permDeniedMeta, setPermDeniedMeta] = useState(false);
  const [updateChannel, setUpdateChannel] = useState<FloraApkUpdateChannelId>(() =>
    getUpdateChannelId(),
  );
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);

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

  const refreshUpdatePrefs = useCallback(() => {
    if (!sideload) return;
    const { hasOs, auto } = reconcileInstallPermissionWithOs();
    setHasInstallPerm(hasOs);
    setAutoUpdate(auto);
    if (hasOs) setPermDeniedMeta(false);
  }, [sideload]);

  const refreshLatest = useCallback(async () => {
    setLatestBusy(true);
    try {
      const next = await fetchLatestUpdateManifest();
      if (mountedRef.current) setLatest(next);
    } catch {
      if (mountedRef.current) setLatest(null);
    } finally {
      if (mountedRef.current) setLatestBusy(false);
    }
  }, []);

  const refreshOfficiality = useCallback(async () => {
    setOfficiality(null);
    try {
      const next = await resolveInstalledBuildOfficiality();
      if (mountedRef.current) setOfficiality(next);
    } catch {
      if (mountedRef.current) setOfficiality("unofficial");
    }
  }, []);

  useEffect(() => {
    void refreshLatest();
    void refreshOfficiality();
  }, [refreshLatest, refreshOfficiality]);

  useEffect(() => {
    if (!sideload) return;
    refreshUpdatePrefs();
    const appSub = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshUpdatePrefs();
    });
    const unsub = subscribeUpdatePreferences(() => refreshUpdatePrefs());
    return () => {
      appSub.remove();
      unsub();
    };
  }, [refreshUpdatePrefs, sideload]);

  const changeInAppUpdates = (enabled: boolean) => {
    if (!sideload || permBusy) return;
    setPermDeniedMeta(false);

    if (!enabled && hasInstallPerm) {
      setPermBusy(true);
      void (async () => {
        try {
          const opened = await openInstallPermissionSettings();
          if (opened) {
            await waitForInstallPermissionResult({ mode: "revoke" });
          }
        } catch {
          // Activity missing / native reject — still reconcile.
        } finally {
          refreshUpdatePrefs();
          setPermBusy(false);
        }
      })();
      return;
    }

    if (enabled && !hasInstallPerm) {
      setPermBusy(true);
      void (async () => {
        try {
          const granted = await openInstallPermissionPrompt();
          refreshUpdatePrefs();
          if (!granted || !canRequestPackageInstalls()) {
            setPermDeniedMeta(true);
          }
        } finally {
          setPermBusy(false);
        }
      })();
      return;
    }

    refreshUpdatePrefs();
  };

  const changeAutoUpdate = (enabled: boolean) => {
    if (!sideload) return;
    if (!enabled) {
      setAutoUpdateEnabled(false);
      setAutoUpdate(false);
      return;
    }
    if (!isInAppUpdatesEnabled() || !canRequestPackageInstalls()) {
      setAutoUpdate(false);
      return;
    }
    setAutoUpdateEnabled(true);
    if (!isAutoUpdateEnabled()) {
      setAutoUpdate(false);
      return;
    }
    setAutoUpdate(true);
    setHasInstallPerm(true);
    void runAppUpdateCatchUp({ force: true }).catch(() => undefined);
  };

  const closeModal = () => {
    setUpdating(false);
    setCancelling(false);
    setProgress(null);
  };

  const handleCancel = () => {
    if (cancelling) return;
    if (progress?.phase === "error" || progress?.phase === "done") {
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

  const handleCheckUpdate = () => {
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
        const result = await runUserUpdateCheck(onProgress);
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

        if (result.status === "up_to_date") {
          onProgress({ phase: "done", message: "Установлена актуальная версия." });
          void refreshLatest();
          void refreshOfficiality();
          return;
        }

        if (result.status === "installed" || result.status === "opened_channel") {
          onProgress({
            phase: "done",
            message:
              result.status === "opened_channel"
                ? "Открыта загрузка APK с канала Flora."
                : "Обновление установлено.",
          });
          void refreshLatest();
          void refreshOfficiality();
          return;
        }

        if (result.status === "pending_user_action") {
          onProgress({
            phase: "installing",
            message: "Подтвердите установку в системном окне",
          });
        }
      } catch (err: unknown) {
        if (cancelledRef.current) {
          closeModal();
          return;
        }
        const detail =
          err instanceof Error && err.message ? err.message : "Не удалось проверить обновление";
        onProgress({ phase: "error", message: detail });
      }
    })();
  };

  const updateAvailable =
    latest?.versionCode != null && latest.versionCode > installedCode;
  const latestApkUrl =
    typeof latest?.apkUrl === "string" && latest.apkUrl.trim().length > 0
      ? latest.apkUrl.trim()
      : null;
  const primaryMode: "download" | "check" =
    !hasInstallPerm && updateAvailable && latestApkUrl != null ? "download" : "check";
  const primaryLabel = hasInstallPerm
    ? "Обновить приложение"
    : primaryMode === "download"
      ? "Скачать обновление"
      : "Проверить обновления";

  const versionVisible = matchesSearch(
    searchQuery,
    "версия",
    "version",
    "apk",
    "канал",
    "обновление",
    "актуальн",
    "официальн",
    "проверить",
    "обновить",
    "скачать",
    "загрузка",
  );

  const officialityLabel =
    officiality == null
      ? "Проверка…"
      : officiality === "official"
        ? "Официальная"
        : "Не официальная";
  const installVisible =
    sideload &&
    matchesSearch(
      searchQuery,
      "установка",
      "разрешение",
      "фон",
      "фоновое",
      "обновление",
      "apk",
      "install",
    );

  if (normalizeSearch(searchQuery) && !versionVisible && !installVisible) {
    return null;
  }

  const backgroundDisabled = !hasInstallPerm || permBusy;

  return (
    <View style={ui.tabBody}>
      {versionVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Версия приложения</Text>
          <View style={ui.fieldsStack}>
            <View style={ui.listCard}>
              <View style={ui.listCardInfo}>
                <Text style={ui.listCardTitle}>{installedVersion}</Text>
                <Text style={ui.listCardDesc}>{officialityLabel}</Text>
              </View>
              {latestBusy ? (
                <ActivityIndicator color={floraColors.greenLight} />
              ) : updateAvailable ? (
                <View style={ui.badge}>
                  <Text style={ui.badgeText}>есть обновление</Text>
                </View>
              ) : latest ? (
                <View style={ui.outlineBadge}>
                  <Text style={ui.outlineBadgeText}>актуально</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.actionsCard}>
              <Pressable
                style={({ pressed }) => [styles.channelRow, pressed && ui.pressed]}
                onPress={() => setChannelPickerOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Выбрать канал обновлений"
              >
                <View style={styles.channelRowText}>
                  <Text style={styles.channelRowLabel}>Канал</Text>
                  <Text style={styles.channelRowValue} numberOfLines={1}>
                    {labelForUpdateChannel(updateChannel)}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={floraColors.gray} />
              </Pressable>

              <View style={styles.actionsDivider} />

              <View style={styles.actionsFooter}>
                <Pressable
                  style={({ pressed }) => [
                    styles.checkButton,
                    (pressed || (primaryMode === "check" && updating)) && ui.pressed,
                    primaryMode === "check" && updating && ui.textActionDisabled,
                  ]}
                  onPress={() => {
                    if (primaryMode === "download" && latestApkUrl) {
                      void Linking.openURL(latestApkUrl);
                      return;
                    }
                    handleCheckUpdate();
                  }}
                  disabled={primaryMode === "check" && updating}
                  accessibilityRole="button"
                  accessibilityLabel={primaryLabel}
                >
                  {primaryMode === "check" && updating ? (
                    <ActivityIndicator color={floraColors.bg} />
                  ) : (
                    <Text style={styles.checkButtonText}>{primaryLabel}</Text>
                  )}
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.downloadLink, pressed && ui.pressed]}
                  onPress={() => void Linking.openURL(FLORA_DOWNLOAD_PAGE)}
                  accessibilityRole="button"
                  accessibilityLabel="Открыть страницу загрузки"
                >
                  <Text style={styles.downloadLinkText}>Канал загрузки</Text>
                  <Ionicons name="open-outline" size={15} color={floraColors.gray} />
                </Pressable>
              </View>
            </View>

            {updateAvailable && latest?.version ? (
              <Text style={ui.sectionHint}>
                На канале Flora доступна версия {latest.version}
                {latest.versionCode != null ? ` (${latest.versionCode})` : ""}.
              </Text>
            ) : null}
            {!sideload ? (
              <Text style={ui.sectionHint}>
                В этой сборке установка APK из приложения недоступна. Обновления приходят через ваш
                канал распространения.
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {installVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Установка из приложения</Text>
          <View style={ui.fieldsStack}>
            <ToggleCard
              title="Установка обновлений"
              description="Нужно для установки из приложения и для фонового обновления."
              value={hasInstallPerm}
              onValueChange={changeInAppUpdates}
              disabled={permBusy}
              footer={permDeniedMeta ? "Разрешение не выдано." : null}
            />
            <ToggleCard
              title="Фоновое обновление"
              description="Скачивание с канала Flora в фоне; установка при свёрнутом приложении (Android 12+)."
              value={autoUpdate}
              onValueChange={changeAutoUpdate}
              disabled={backgroundDisabled}
            />
          </View>
        </View>
      ) : null}

      <Modal
        visible={channelPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setChannelPickerOpen(false)}
      >
        <View style={styles.channelBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setChannelPickerOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Закрыть"
          />
          <View style={styles.channelSheet} accessibilityViewIsModal>
            <Text style={styles.channelSheetTitle}>Канал обновлений</Text>
            {FLORA_APK_UPDATE_CHANNELS.map((option) => {
              const selected = option.id === updateChannel;
              return (
                <Pressable
                  key={option.id}
                  style={({ pressed }) => [styles.channelOptionRow, pressed && ui.pressed]}
                  onPress={() => {
                    setUpdateChannelId(option.id);
                    setUpdateChannel(option.id);
                    setChannelPickerOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={option.label}
                >
                  <Text
                    style={[
                      styles.channelOptionLabel,
                      selected && styles.channelOptionLabelSelected,
                    ]}
                  >
                    {option.label}
                  </Text>
                  {selected ? (
                    <Ionicons name="checkmark" size={20} color={floraColors.greenLight} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      </Modal>

      <AppUpdateProgressModal
        visible={updating && progress != null}
        progress={progress}
        onClose={closeModal}
        onCancel={handleCancel}
        cancelling={cancelling}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  actionsCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
    backgroundColor: "rgba(250, 250, 250, 0.03)",
    overflow: "hidden",
  },
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid,
    minHeight: floraSpacing.grid * 4,
  },
  channelRowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  channelRowLabel: {
    color: floraColors.gray,
    fontSize: 12,
    fontWeight: "300",
    letterSpacing: 0.36,
  },
  channelRowValue: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  actionsDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(250, 250, 250, 0.08)",
    marginHorizontal: floraSpacing.grid,
  },
  actionsFooter: {
    paddingHorizontal: floraSpacing.grid,
    paddingTop: floraSpacing.grid,
    paddingBottom: floraSpacing.grid,
    gap: floraSpacing.gridFine * 2,
  },
  checkButton: {
    height: floraSpacing.grid * 3,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: floraColors.greenLight,
  },
  checkButtonText: {
    color: floraColors.bg,
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
  },
  downloadLink: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine,
    minHeight: floraSpacing.grid * 2,
    paddingVertical: floraSpacing.gridFine,
  },
  downloadLinkText: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  channelBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: floraSpacing.grid * 2,
  },
  channelSheet: {
    width: "100%",
    maxWidth: 320,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
    backgroundColor: floraColors.surfaceElevated,
    paddingVertical: floraSpacing.gridFine,
    paddingHorizontal: floraSpacing.grid,
    gap: floraSpacing.gridFine,
  },
  channelSheetTitle: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.45,
    paddingHorizontal: floraSpacing.gridFine,
    paddingVertical: floraSpacing.gridFine * 2,
  },
  channelOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    minHeight: floraSpacing.grid * 3,
    paddingHorizontal: floraSpacing.gridFine,
    paddingVertical: floraSpacing.gridFine,
  },
  channelOptionLabel: {
    flex: 1,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  channelOptionLabelSelected: {
    color: floraColors.greenLight,
  },
});
