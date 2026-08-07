import {
  canRequestPackageInstalls,
  openInstallPermissionSettings,
} from "flora-apk-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  Switch,
  Text,
  View,
} from "react-native";
import { AppUpdateProgressModal } from "@/components/notifications/AppUpdateProgressModal";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import {
  cancelInteractiveApkUpdate,
  fetchLatestUpdateManifest,
  getInstalledVersionCode,
  isAutoUpdateEnabled,
  isInAppUpdatesEnabled,
  isSideloadUpdatesEnabled,
  openInstallPermissionPrompt,
  reconcileInstallPermissionWithOs,
  runAppUpdateCatchUp,
  runUserUpdateCheck,
  setAutoUpdateEnabled,
  subscribeUpdatePreferences,
  type ApkUpdateProgress,
  type AndroidUpdateManifest,
} from "@/lib/apkUpdate";
import { waitForInstallPermissionResult } from "@/lib/apkUpdate/waitForInstallPermission";
import { FLORA_DOWNLOAD_PAGE, getFloraSocialAppVersion } from "@/lib/appLinks";
import { floraColors } from "@/lib/theme";

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
  const [autoUpdate, setAutoUpdate] = useState(() => isAutoUpdateEnabled());
  const [hasInstallPerm, setHasInstallPerm] = useState(() =>
    sideload ? canRequestPackageInstalls() : false,
  );
  const [permBusy, setPermBusy] = useState(false);
  const [permDeniedMeta, setPermDeniedMeta] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

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

  useEffect(() => {
    void refreshLatest();
  }, [refreshLatest]);

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
    setStatusError(null);
    setStatusMessage(null);
    setUpdating(true);
    setCancelling(false);
    setProgress(null);

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
          setStatusError(result.error);
          return;
        }

        if (result.status === "up_to_date") {
          closeModal();
          setStatusMessage("Установлена актуальная версия.");
          void refreshLatest();
          return;
        }

        if (result.status === "installed" || result.status === "opened_channel") {
          closeModal();
          setStatusMessage(
            result.status === "opened_channel"
              ? "Открыта загрузка APK с канала Flora."
              : "Обновление установлено.",
          );
          void refreshLatest();
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
        setStatusError(detail);
      }
    })();
  };

  const updateAvailable =
    latest?.versionCode != null && latest.versionCode > installedCode;

  const versionVisible = matchesSearch(
    searchQuery,
    "версия",
    "version",
    "apk",
    "канал",
    "обновление",
    "актуальн",
  );
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
  const actionsVisible = matchesSearch(
    searchQuery,
    "проверить",
    "обновить",
    "скачать",
    "канал",
    "загрузка",
    "обновление",
  );

  if (
    normalizeSearch(searchQuery) &&
    !versionVisible &&
    !installVisible &&
    !actionsVisible
  ) {
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
                <Text style={ui.listCardDesc}>
                  {installedCode > 0
                    ? `Установлено · versionCode ${installedCode}`
                    : "Установленная сборка Flora Social"}
                </Text>
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

      {actionsVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Проверка и загрузка</Text>
          <View style={ui.fieldsStack}>
            <Text style={ui.sectionHint}>
              Кнопка «Обновить» также есть в уведомлении о новой версии. Здесь можно проверить канал
              вручную.
            </Text>
            <View style={ui.formActionsRow}>
              <Pressable
                style={({ pressed }) => [
                  ui.softPrimaryButton,
                  (pressed || updating) && ui.pressed,
                  updating && ui.textActionDisabled,
                ]}
                onPress={handleCheckUpdate}
                disabled={updating}
                accessibilityRole="button"
                accessibilityLabel="Проверить обновления"
              >
                {updating ? (
                  <ActivityIndicator color={floraColors.greenLight} />
                ) : (
                  <Text style={ui.softPrimaryButtonText}>
                    {updateAvailable ? "Обновить" : "Проверить обновления"}
                  </Text>
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [ui.softMutedButton, pressed && ui.pressed]}
                onPress={() => void Linking.openURL(FLORA_DOWNLOAD_PAGE)}
                accessibilityRole="button"
                accessibilityLabel="Открыть страницу загрузки"
              >
                <Text style={ui.softMutedButtonText}>Канал загрузки</Text>
              </Pressable>
            </View>
            {statusError ? <Text style={ui.feedbackError}>{statusError}</Text> : null}
            {statusMessage ? <Text style={ui.feedbackSuccess}>{statusMessage}</Text> : null}
          </View>
        </View>
      ) : null}

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
