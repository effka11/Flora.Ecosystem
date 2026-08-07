import {
  areSecurePushPreviewsEnabled,
  setSecurePushPreviewsEnabled,
} from "flora-secure-push";
import { useState } from "react";
import { Switch, Text, View } from "react-native";
import { settingsUi as ui } from "@/components/settings/settingsUi";
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

export function NotificationsSettingsTab({ searchQuery }: Props) {
  const [showMessageText, setShowMessageText] = useState(() => areSecurePushPreviewsEnabled());

  const changeShowMessageText = (enabled: boolean) => {
    setShowMessageText(enabled);
    setSecurePushPreviewsEnabled(enabled);
  };

  const channelsVisible = matchesSearch(
    searchQuery,
    "текст",
    "сообщения",
    "push",
    "превью",
    "уведомления",
    "каналы",
  );
  const aboutVisible = matchesSearch(
    searchQuery,
    "push",
    "release",
    "sse",
    "уведомления",
    "android",
    "fcm",
  );

  if (normalizeSearch(searchQuery) && !channelsVisible && !aboutVisible) {
    return null;
  }

  return (
    <View style={ui.tabBody}>
      {channelsVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Каналы уведомлений</Text>
          <View style={ui.fieldsStack}>
            <View style={ui.listCard}>
              <View style={ui.listCardInfo}>
                <Text style={ui.listCardTitle}>Показывать текст сообщений</Text>
                <Text style={ui.listCardDesc}>
                  Текст расшифровывается только на этом устройстве. APNs и FCM получают шифротекст.
                </Text>
              </View>
              <View style={ui.listCardActionCol}>
                <Switch
                  value={showMessageText}
                  onValueChange={changeShowMessageText}
                  trackColor={{ false: floraColors.surface, true: floraColors.accentDark }}
                  thumbColor={floraColors.whiteTemplate}
                />
              </View>
            </View>
          </View>
        </View>
      ) : null}

      {aboutVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>О доставке</Text>
          <View style={ui.fieldsStack}>
            <Text style={ui.sectionHint}>
              Push о новых сообщениях работает в release-сборке Flora. В Flora Dev обновления inbox
              приходят через интернет (SSE), пока приложение открыто.
            </Text>
            <Text style={ui.sectionHint}>
              Release Android: google-services.json и разрешения уведомлений (см. Apps/Mobile/README.md).
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
