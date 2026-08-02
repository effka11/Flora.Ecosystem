import { apiDeleteConversation } from "@flora/client-core/api";
import type { MsgConversationDto } from "@flora/client-core/contracts";
import { sharedPresenceStore } from "@flora/client-core/presence";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { router, useNavigation } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ConversationMoreMenu } from "@/components/messages/ConversationMoreMenu";
import { OnlineStatusDot } from "@/components/messages/OnlineStatusDot";
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
  isMuted?: boolean;
  isArchived?: boolean;
  onMutedChange?: (muted: boolean) => void;
  onArchivedChange?: (archived: boolean) => void;
};

export function ConversationListRow({
  item,
  isMuted = false,
  isArchived = false,
  onMutedChange,
  onArchivedChange,
}: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const tabBarBottomInset = Math.max(insets.bottom, 8);
  const displayName = item.otherDisplayName || item.otherUsername;
  const username = item.otherUsername.replace(/^@+/, "") || "…";
  const preview = formatConversationPreview(item, item.preview);
  const moreBtnRef = useRef<View>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [presenceTick, setPresenceTick] = useState(0);
  useEffect(() => sharedPresenceStore.subscribe(() => setPresenceTick((n) => n + 1)), []);
  void presenceTick;
  const overlay = sharedPresenceStore.overlayOnline(
    item.otherUserUuid,
    item.otherUserIsOnline,
    item.otherUserLastSeenAt,
  );

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
        otherUserIsOnline: overlay.isOnline ? "1" : "0",
        otherUserLastSeenAt: overlay.lastSeenAt ?? "",
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
          <OnlineStatusDot
            key={item.otherUserUuid}
            identityKey={item.otherUserUuid}
            online={overlay.isOnline}
          />
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
        <View ref={moreBtnRef} collapsable={false}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={menuOpen ? `Закрыть меню чата` : `Действия — ${displayName}`}
            accessibilityState={{ expanded: menuOpen }}
            style={({ pressed }) => [styles.moreBtn, pressed && styles.moreBtnPressed]}
            hitSlop={8}
            onPress={() => setMenuOpen((open) => !open)}
          >
            <Ionicons
              name={menuOpen ? "close" : "ellipsis-vertical"}
              size={18}
              color={floraColors.gray}
            />
          </Pressable>
        </View>
      </View>

      <ConversationMoreMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={moreBtnRef}
        isMuted={isMuted}
        isArchived={isArchived}
        onMuteForever={() => onMutedChange?.(true)}
        onMuteTemporary={() => onMutedChange?.(true)}
        onUnmute={() => onMutedChange?.(false)}
        onArchive={() => onArchivedChange?.(true)}
        onUnarchive={() => onArchivedChange?.(false)}
        onDelete={() => {
          Alert.alert("Удалить чат?", `Чат с ${displayName} будет удалён.`, [
            { text: "Отмена", style: "cancel" },
            {
              text: "Удалить",
              style: "destructive",
              onPress: () => {
                void (async () => {
                  try {
                    await apiDeleteConversation(item.conversationUuid, item.otherUserUuid);
                    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
                  } catch {
                    Alert.alert("Не удалось удалить чат", "Попробуйте ещё раз.");
                  }
                })();
              },
            },
          ]);
        }}
      />
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
