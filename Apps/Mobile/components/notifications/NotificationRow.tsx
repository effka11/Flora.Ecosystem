import { Ionicons } from "@expo/vector-icons";
import type { NotificationDto } from "@flora/client-core/contracts";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { formatNotificationTimeAgoRu } from "@/lib/formatNotificationTimeAgoRu";
import { FLORA_GITHUB_RELEASES_URL } from "@/lib/appLinks";
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

function openAppUpdateReleases(): void {
  void Linking.openURL(FLORA_GITHUB_RELEASES_URL);
}

export function NotificationRow({ item, onPress }: NotificationRowProps) {
  const iconName = iconForType(item.type);
  const iconColors = iconColorsForType(item.type);
  const showUpdateButton = item.type === "app_update";

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
      {showUpdateButton ? (
        <Pressable
          style={({ pressed }) => [styles.updateBtn, pressed && styles.itemPressed]}
          onPress={openAppUpdateReleases}
          accessibilityRole="button"
          accessibilityLabel="Обновить приложение"
        >
          <Text style={styles.updateBtnText}>Обновить</Text>
        </Pressable>
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
  },
  updateBtnText: {
    color: floraColors.bg,
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.39,
  },
});
