import type { MsgConversationDto } from "@flora/client-core/contracts";
import { Ionicons } from "@expo/vector-icons";
import { router, useNavigation } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { floraColors, floraSpacing } from "@/lib/theme";
import { applyMessagesTabBarHidden } from "@/lib/messagesTabBar";

const LIST_PREVIEW_MAX_LEN = 80;
const AVATAR_SIZE = floraSpacing.grid * 3;
const DECRYPT_FAIL_LABEL = "[ не удалось расшифровать ]";

export function formatConversationPreview(
  item: Pick<MsgConversationDto, "lastMessageIsFromMe">,
  preview: string,
): string {
  const format = (plain: string) => {
    const body = plain.trim();
    if (body === "Расшифровка…") return body;
    if (!body || body === "…") return "Нет сообщений";
    const truncated =
      body.length > LIST_PREVIEW_MAX_LEN ? `${body.slice(0, LIST_PREVIEW_MAX_LEN)}…` : body;
    const normalized = truncated === "🔒" ? DECRYPT_FAIL_LABEL : truncated;
    return item.lastMessageIsFromMe ? `Вы: ${normalized}` : normalized;
  };

  return format(preview);
}

type Props = {
  item: MsgConversationDto & { preview: string };
};

export function ConversationListRow({ item }: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const tabBarBottomInset = Math.max(insets.bottom, 8);
  const displayName = item.otherDisplayName || item.otherUsername;
  const username = item.otherUsername.replace(/^@+/, "") || "…";
  const preview = formatConversationPreview(item, item.preview);

  const openChat = () => {
    applyMessagesTabBarHidden(navigation, tabBarBottomInset, true);
    router.push({
      pathname: "/(tabs)/messages/[conversationUuid]",
      params: {
        conversationUuid: item.conversationUuid,
        otherUserUuid: item.otherUserUuid,
        otherDisplayName: item.otherDisplayName,
        otherUsername: item.otherUsername,
        otherAvatarUuid: item.otherAvatarUuid ?? "",
        otherUserIsOnline: item.otherUserIsOnline ? "1" : "0",
        otherUserLastSeenAt: item.otherUserLastSeenAt ?? "",
      },
    });
  };

  return (
    <View style={styles.shell}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть чат с ${displayName}`}
        style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
        onPress={openChat}
      >
        <View style={styles.avatarWrap}>
          <FloraAvatar
            size={AVATAR_SIZE}
            avatarUuid={item.otherAvatarUuid}
            displayName={displayName}
            username={item.otherUsername}
            seed={item.otherUserUuid ?? item.otherUsername}
          />
          {item.otherUserIsOnline ? <View style={styles.onlineBadge} /> : null}
        </View>

        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text style={styles.name} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={styles.handle} numberOfLines={1}>
              @{username}
            </Text>
          </View>
          <Text style={styles.preview} numberOfLines={1}>
            {preview}
          </Text>
        </View>
      </Pressable>

      <View style={styles.trailing}>
        {item.unreadCount > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{item.unreadCount > 99 ? "99+" : item.unreadCount}</Text>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Действия — ${displayName}`}
          style={({ pressed }) => [styles.moreBtn, pressed && styles.moreBtnPressed]}
          hitSlop={8}
          onPress={() => undefined}
        >
          <Ionicons name="ellipsis-vertical" size={18} color={floraColors.gray} />
        </Pressable>
      </View>
    </View>
  );
}

export const CONVERSATION_ROW_ESTIMATED_HEIGHT =
  AVATAR_SIZE + (floraSpacing.grid * 2 - 1) + (floraSpacing.grid * 2 - 2);

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
  avatarWrap: {
    position: "relative",
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    flexShrink: 0,
  },
  onlineBadge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: floraColors.greenLight,
    borderWidth: 2,
    borderColor: floraColors.bg,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: floraSpacing.gridFine,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: floraSpacing.gridFine * 2,
    minWidth: 0,
  },
  name: {
    flexShrink: 1,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 20,
  },
  handle: {
    flexShrink: 0,
    color: floraColors.gray,
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
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine,
    flexShrink: 0,
    alignSelf: "stretch",
    paddingRight: floraSpacing.grid,
    paddingTop: floraSpacing.grid * 2 - 1,
    paddingBottom: floraSpacing.grid * 2 - 2,
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
  moreBtn: {
    width: floraSpacing.gridFine * 2 + 18,
    height: floraSpacing.gridFine * 2 + 18,
    alignItems: "center",
    justifyContent: "center",
  },
  moreBtnPressed: {
    opacity: 0.72,
  },
});
