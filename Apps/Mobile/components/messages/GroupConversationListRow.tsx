import { useNavigation } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ConversationListSelectionMark } from "@/components/messages/ConversationListSelectionMark";
import type { GroupChat } from "@/lib/groupChatTypes";
import { applyMessagesTabBarHidden } from "@/lib/messagesTabBar";
import { openGroupChat } from "@/lib/openGroupChat";
import { floraColors, floraSpacing } from "@/lib/theme";

/** Same metrics as ConversationListRow — keep group rows in the same list rhythm. */
const LIST_PREVIEW_MAX_LEN = 80;
const AVATAR_SIZE = floraSpacing.grid * 3;
const DECRYPT_FAIL_LABEL = "[ не удалось расшифровать ]";
const LONG_PRESS_MS = 350;
/** Как `iconButton` / «+» в TabScreenSearchHeader — центр бейджа под «+». */
const HEADER_TRAILING_ICON_SLOT = 45;

function formatGroupPreview(preview: string, fromMe: boolean): string {
  const body = preview.trim();
  if (body === "Расшифровка…") return body;
  if (!body || body === "…") return "Нет сообщений";
  const truncated =
    body.length > LIST_PREVIEW_MAX_LEN ? `${body.slice(0, LIST_PREVIEW_MAX_LEN)}…` : body;
  const normalized = truncated === "🔒" ? DECRYPT_FAIL_LABEL : truncated;
  return fromMe ? `Вы: ${normalized}` : normalized;
}

type Props = {
  group: GroupChat;
  preview: string;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onEnterSelect?: () => void;
};

export function GroupConversationListRow({
  group,
  preview,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onEnterSelect,
}: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const tabBarBottomInset = Math.max(insets.bottom, 8);
  const title = group.title.trim() || "Группа";
  const previewText =
    preview.trim().length > 0
      ? formatGroupPreview(preview, group.lastMessageIsFromMe)
      : "Нет сообщений";

  const open = () => {
    applyMessagesTabBarHidden(navigation, tabBarBottomInset, true);
    openGroupChat(group.conversationUuid, title);
  };

  const onPress = () => {
    if (selectionMode) {
      onToggleSelect?.();
      return;
    }
    open();
  };

  const onLongPress = () => {
    if (selectionMode) {
      onToggleSelect?.();
      return;
    }
    onEnterSelect?.();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        selectionMode
          ? selected
            ? `Снять выбор — ${title}`
            : `Выбрать группу — ${title}`
          : `Открыть группу ${title}`
      }
      accessibilityState={selectionMode ? { selected } : undefined}
      style={({ pressed }) => [
        styles.shell,
        selected && styles.shellSelected,
        pressed && styles.shellPressed,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={LONG_PRESS_MS}
    >
      <View style={styles.item}>
        <View style={styles.avatarWrap}>
          <FloraAvatar size={AVATAR_SIZE} displayName={title} seed={group.conversationUuid} />
          {selectionMode ? (
            <ConversationListSelectionMark selected={selected} avatarDiameter={AVATAR_SIZE} />
          ) : null}
        </View>

        <View style={styles.body}>
          <Text style={styles.name} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.preview} numberOfLines={1}>
            {previewText}
          </Text>
        </View>
      </View>

      {group.unreadCount > 0 ? (
        <View style={styles.trailing}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {group.unreadCount > 99 ? "99+" : group.unreadCount}
            </Text>
          </View>
        </View>
      ) : null}
    </Pressable>
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
  shellSelected: {
    backgroundColor: "rgba(164, 209, 138, 0.12)",
  },
  shellPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.04)",
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
  avatarWrap: {
    position: "relative",
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: floraSpacing.gridFine,
  },
  name: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  preview: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  trailing: {
    width: HEADER_TRAILING_ICON_SLOT,
    // Как paddingHorizontal topBlock — правый край слота = правый край «+».
    marginRight: floraSpacing.grid,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  badge: {
    minWidth: floraSpacing.gridFine * 4,
    height: floraSpacing.gridFine * 4,
    paddingHorizontal: floraSpacing.gridFine,
    borderRadius: 11,
    backgroundColor: "rgba(164, 209, 138, 0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#10200e",
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
});
