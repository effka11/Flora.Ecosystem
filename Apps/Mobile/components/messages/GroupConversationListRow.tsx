import {
  apiLeaveGroup,
  ApiRequestError,
} from "@flora/client-core/api";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ConversationMoreMenu } from "@/components/messages/ConversationMoreMenu";
import type { GroupChat } from "@/lib/groupChatTypes";
import { applyMessagesTabBarHidden } from "@/lib/messagesTabBar";
import { openGroupChat } from "@/lib/openGroupChat";
import { floraColors, floraSpacing } from "@/lib/theme";

/** Same metrics as ConversationListRow — keep group rows in the same list rhythm. */
const LIST_PREVIEW_MAX_LEN = 80;
const AVATAR_SIZE = floraSpacing.grid * 3;
const DECRYPT_FAIL_LABEL = "[ не удалось расшифровать ]";

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
  isArchived?: boolean;
  onArchive?: () => void;
  onUnarchive?: () => void;
};

export function GroupConversationListRow({
  group,
  preview,
  isArchived = false,
  onArchive,
  onUnarchive,
}: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const tabBarBottomInset = Math.max(insets.bottom, 8);
  const title = group.title.trim() || "Группа";
  const previewText =
    preview.trim().length > 0
      ? formatGroupPreview(preview, group.lastMessageIsFromMe)
      : "Нет сообщений";
  const moreBtnRef = useRef<View>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const open = () => {
    applyMessagesTabBarHidden(navigation, tabBarBottomInset, true);
    openGroupChat(group.conversationUuid, title);
  };

  const leave = () => {
    Alert.alert("Выйти из группы?", "Вы больше не будете получать сообщения этой группы.", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Выйти",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await apiLeaveGroup(group.conversationUuid);
              void queryClient.invalidateQueries({ queryKey: ["groups"] });
            } catch (e) {
              if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) {
                void queryClient.invalidateQueries({ queryKey: ["groups"] });
                return;
              }
              Alert.alert(
                "Не удалось выйти",
                e instanceof Error ? e.message : "Попробуйте ещё раз.",
              );
            }
          })();
        },
      },
    ]);
  };

  return (
    <View style={styles.shell}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть группу ${title}`}
        style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
        onPress={open}
      >
        <View style={styles.avatarWrap}>
          <FloraAvatar size={AVATAR_SIZE} displayName={title} seed={group.conversationUuid} />
        </View>

        <View style={styles.body}>
          <Text style={styles.name} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.preview} numberOfLines={1}>
            {previewText}
          </Text>
        </View>
      </Pressable>

      <View style={styles.trailing}>
        {group.unreadCount > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {group.unreadCount > 99 ? "99+" : group.unreadCount}
            </Text>
          </View>
        ) : null}
        <View ref={moreBtnRef} collapsable={false}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={menuOpen ? "Закрыть меню группы" : `Действия — ${title}`}
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
        kind="groupChat"
        isArchived={isArchived}
        onMuteForever={() => undefined}
        onMuteTemporary={() => undefined}
        onUnmute={() => undefined}
        onArchive={onArchive ?? (() => undefined)}
        onUnarchive={onUnarchive ?? (() => undefined)}
        onDelete={leave}
      />
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
