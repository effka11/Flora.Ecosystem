import { Ionicons } from "@expo/vector-icons";
import {
  areSecurePushPreviewsEnabled,
  setSecurePushPreviewsEnabled,
} from "flora-secure-push";
import { useCallback, useEffect, useState } from "react";
import {
  AppState,
  Pressable,
  Switch,
  Text,
  View,
} from "react-native";
// RNGH TextInput: при активации pager-pan получает ACTION_CANCEL — иначе
// EditText ведёт курсор и рисует лупу выделения весь горизонтальный свайп.
import { TextInput } from "react-native-gesture-handler";
import * as Notifications from "expo-notifications";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import { isNativePushEnabled } from "@/lib/pushCapabilities";
import { requestPushPermissions } from "@/lib/pushNotifications";
import {
  maskQuietTimeInput,
  NOTIFICATION_CHANNEL_COLS,
  NOTIFICATION_EVENT_ROWS,
  type NotificationChannelKey,
  type NotificationEventKey,
} from "@/lib/settingsNotificationsDraft";
import { floraColors, floraSpacing } from "@/lib/theme";
import { useSettingsDraftStore } from "@/stores/settingsDraftStore";

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

function MatrixCheck({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={6}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      style={({ pressed }) => [pressed && ui.pressed]}
    >
      <View style={[ui.matrixCheck, checked && ui.matrixCheckOn]}>
        {checked ? <Ionicons name="checkmark" size={14} color={floraColors.greenLight} /> : null}
      </View>
    </Pressable>
  );
}

export function NotificationsSettingsTab({ searchQuery }: Props) {
  const notifications = useSettingsDraftStore((s) => s.notifications);
  const updateNotifications = useSettingsDraftStore((s) => s.updateNotifications);
  const clearSaveFeedback = useSettingsDraftStore((s) => s.clearSaveFeedback);
  const saveError = useSettingsDraftStore((s) => s.saveError);
  const saveSuccess = useSettingsDraftStore((s) => s.saveSuccess);

  const nativePush = isNativePushEnabled();
  const [showMessageText, setShowMessageText] = useState(() => areSecurePushPreviewsEnabled());
  const [osPushGranted, setOsPushGranted] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushDeniedMeta, setPushDeniedMeta] = useState(false);

  const refreshOsPush = useCallback(async () => {
    if (!nativePush) {
      setOsPushGranted(false);
      return;
    }
    try {
      const { status } = await Notifications.getPermissionsAsync();
      setOsPushGranted(status === "granted");
      if (status === "granted") setPushDeniedMeta(false);
    } catch {
      setOsPushGranted(false);
    }
  }, [nativePush]);

  useEffect(() => {
    void refreshOsPush();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshOsPush();
    });
    return () => sub.remove();
  }, [refreshOsPush]);

  const patch = (next: Partial<typeof notifications>) => {
    clearSaveFeedback();
    updateNotifications(next);
  };

  const changeShowMessageText = (enabled: boolean) => {
    setShowMessageText(enabled);
    setSecurePushPreviewsEnabled(enabled);
  };

  const changePushEnabled = (enabled: boolean) => {
    if (!nativePush || pushBusy) return;
    setPushDeniedMeta(false);
    if (!enabled) {
      patch({ pushEnabled: false });
      return;
    }
    setPushBusy(true);
    void (async () => {
      try {
        const granted = await requestPushPermissions();
        await refreshOsPush();
        if (!granted) {
          setPushDeniedMeta(true);
          patch({ pushEnabled: false });
          return;
        }
        patch({ pushEnabled: true });
      } finally {
        setPushBusy(false);
      }
    })();
  };

  const toggleEvent = (event: NotificationEventKey, channel: NotificationChannelKey) => {
    const row = notifications.events[event];
    patch({
      events: {
        ...notifications.events,
        [event]: { ...row, [channel]: !row[channel] },
      },
    });
  };

  const channelsVisible = matchesSearch(
    searchQuery,
    "канал",
    "push",
    "email",
    "почта",
    "текст",
    "сообщения",
    "превью",
    "уведомления",
  );
  const quietVisible = matchesSearch(
    searchQuery,
    "тишин",
    "тихий",
    "quiet",
    "расписание",
    "режим",
  );
  const matrixVisible = matchesSearch(
    searchQuery,
    "матрица",
    "событ",
    "лайк",
    "упоминан",
    "заявк",
    "сообществ",
    "пост",
  );
  if (
    normalizeSearch(searchQuery) &&
    !channelsVisible &&
    !quietVisible &&
    !matrixVisible
  ) {
    return null;
  }

  const pushValue = notifications.pushEnabled && (osPushGranted ?? true);

  return (
    <View style={ui.tabBody}>
      {saveError ? <Text style={ui.feedbackError}>{saveError}</Text> : null}
      {saveSuccess ? <Text style={ui.feedbackSuccess}>{saveSuccess}</Text> : null}

      {channelsVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Каналы уведомлений</Text>
          <View style={ui.fieldsStack}>
            <ToggleCard
              title="Push-уведомления"
              description={
                nativePush
                  ? "Получать уведомления, когда приложение свёрнуто"
                  : "В Flora Dev OS push отключён — inbox обновляется через SSE"
              }
              value={nativePush ? pushValue : false}
              onValueChange={changePushEnabled}
              disabled={!nativePush || pushBusy}
              footer={
                pushDeniedMeta
                  ? "Разрешение не выдано."
                  : nativePush && osPushGranted === false && notifications.pushEnabled
                    ? "Нужно разрешение системы на уведомления."
                    : null
              }
            />
            <ToggleCard
              title="Email уведомления"
              description="Дайджесты и важные оповещения на почту"
              value={notifications.emailEnabled}
              onValueChange={(emailEnabled) => patch({ emailEnabled })}
            />
            <ToggleCard
              title="Показывать текст сообщений"
              description="Текст расшифровывается только на этом устройстве. APNs и FCM получают шифротекст."
              value={showMessageText}
              onValueChange={changeShowMessageText}
            />
          </View>
        </View>
      ) : null}

      {quietVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Режим тишины</Text>
          <View style={ui.fieldsStack}>
            <View style={[ui.listCard, { flexDirection: "column", alignItems: "stretch" }]}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: floraSpacing.grid,
                }}
              >
                <View style={[ui.listCardInfo, { flex: 1 }]}>
                  <Text style={ui.listCardTitle}>Тихий режим по расписанию</Text>
                  <Text style={ui.listCardDesc}>
                    Отключать звуки и push-уведомления в заданное время
                  </Text>
                </View>
                <View style={ui.listCardActionCol}>
                  <Switch
                    value={notifications.quietMode}
                    onValueChange={(quietMode) => patch({ quietMode })}
                    trackColor={{ false: floraColors.surface, true: floraColors.accentDark }}
                    thumbColor={floraColors.whiteTemplate}
                  />
                </View>
              </View>

              {notifications.quietMode ? (
                <View style={ui.quietExpand}>
                  <View style={ui.quietTimeRow}>
                    <View style={ui.quietTimeField}>
                      <Text style={ui.fieldLabel}>С</Text>
                      <TextInput
                        style={ui.input}
                        value={notifications.quietFrom}
                        onChangeText={(raw) => patch({ quietFrom: maskQuietTimeInput(raw) })}
                        placeholder="23:00"
                        placeholderTextColor="rgba(250, 250, 250, 0.3)"
                        keyboardType="number-pad"
                        maxLength={5}
                      />
                    </View>
                    <View style={ui.quietTimeField}>
                      <Text style={ui.fieldLabel}>До</Text>
                      <TextInput
                        style={ui.input}
                        value={notifications.quietTo}
                        onChangeText={(raw) => patch({ quietTo: maskQuietTimeInput(raw) })}
                        placeholder="08:00"
                        placeholderTextColor="rgba(250, 250, 250, 0.3)"
                        keyboardType="number-pad"
                        maxLength={5}
                      />
                    </View>
                  </View>
                  <Pressable
                    style={({ pressed }) => [ui.confirmCheckRow, pressed && ui.pressed]}
                    onPress={() =>
                      patch({ quietAllowImportant: !notifications.quietAllowImportant })
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: notifications.quietAllowImportant }}
                  >
                    <View
                      style={[
                        ui.confirmCheckBox,
                        notifications.quietAllowImportant && ui.confirmCheckBoxOn,
                      ]}
                    >
                      {notifications.quietAllowImportant ? (
                        <Ionicons name="checkmark" size={14} color={floraColors.greenLight} />
                      ) : null}
                    </View>
                    <Text style={ui.confirmCheckLabel}>
                      Оставлять важные уведомления (упоминания, личные сообщения)
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      ) : null}

      {matrixVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Матрица событий</Text>
          <View style={ui.fieldsStack}>
            <View style={ui.matrixWrap}>
              <View style={ui.matrixHeaderRow}>
                <View style={ui.matrixEventCol}>
                  <Text style={ui.matrixChannelLabel}>Событие</Text>
                </View>
                {NOTIFICATION_CHANNEL_COLS.map((col) => (
                  <View key={col.key} style={ui.matrixChannelCol}>
                    <Text style={ui.matrixChannelLabel}>{col.label}</Text>
                  </View>
                ))}
              </View>
              {NOTIFICATION_EVENT_ROWS.map((row, index) => {
                const last = index === NOTIFICATION_EVENT_ROWS.length - 1;
                return (
                  <View
                    key={row.key}
                    style={[ui.matrixRow, last && ui.matrixRowLast]}
                  >
                    <View style={ui.matrixEventCol}>
                      <Text style={ui.matrixEventText}>{row.label}</Text>
                    </View>
                    {NOTIFICATION_CHANNEL_COLS.map((col) => (
                      <View key={col.key} style={ui.matrixChannelCol}>
                        <MatrixCheck
                          checked={notifications.events[row.key][col.key]}
                          onToggle={() => toggleEvent(row.key, col.key)}
                        />
                      </View>
                    ))}
                  </View>
                );
              })}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}
