import { liveGridStyles } from "@/lib/liveGridStyles";
import { formatGroupListPreview } from "@flora/client-core/messaging";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ConversationListSelectionMark } from "@/components/messages/ConversationListSelectionMark";
import { warmParkedChatAvatars } from "@/lib/chatOpenAvatarWarm";
import { warmChatOpenThreadAtPressIn } from "@/lib/chatOpenLayoutWarm";
import { markChatOpenPark, markChatOpenTap } from "@/lib/chatOpenTrace";
import type { GroupChat } from "@/lib/groupChatTypes";
import {
  armChatPushEnter,
  cancelScheduledChatRowPark,
  didScrollCancelChatPark,
  flushScheduledChatRowPark,
  isChatPushHoldingSlide,
  isChatPushPressBlocked,
  isChatPushTracked,
  prepareChatPushPress,
  parkChatPush,
  requestChatPushPlay,
  scheduleChatRowPark,
} from "@/lib/chatPushTransition";
import { floraColors, floraFeedPost, floraSpacing, kegl, sPx, tracking } from "@/lib/theme";

/** Same metrics as ConversationListRow — keep group rows in the same list rhythm. */
const AVATAR_SIZE = () => floraSpacing.grid * 3;
/** Как наполнение поста: padding карточки + contentInsetRight = 25px от края экрана. */
const CONTENT_INSET_RIGHT_FROM_SCREEN = () => floraFeedPost.paddingHorizontal + floraFeedPost.contentInsetRight;
const LONG_PRESS_MS = 350;
/** Как `iconButton` / «+» в TabScreenSearchHeader — центр бейджа под «+». */
const HEADER_TRAILING_ICON_SLOT = () => 3 * floraSpacing.grid;

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
  const [lit, setLit] = useState(false);
  const title = group.title.trim() || "Группа";
  const previewText = formatGroupListPreview({
    preview: preview.trim().length > 0 ? preview : group.lastMessagePreview ?? "",
    isFromMe: group.lastMessageIsFromMe,
    senderDisplayName: group.lastMessageSenderDisplayName,
  });

  const threadParams = {
    conversationUuid: group.conversationUuid,
    kind: "groupChat",
    title,
  };

  const pushThread = () => {
    router.push({
      pathname: "/(tabs)/messages/[conversationUuid]",
      params: threadParams,
    });
  };

  const open = () => {
    // Reduce motion и пути без парковки: экран встаёт сразу.
    armChatPushEnter();
    markChatOpenTap(group.conversationUuid);
    pushThread();
  };

  const parkRow = () => {
    warmChatOpenThreadAtPressIn({ kind: "group", conversationUuid: group.conversationUuid });
    void warmParkedChatAvatars(group.members.map((member) => member.avatarUuid));
    const parked = parkChatPush({
      params: threadParams,
      navigate: pushThread,
    });
    if (parked === "parked") markChatOpenPark(group.conversationUuid);
  };

  const onPress = () => {
    const scrollCancelled = didScrollCancelChatPark();
    if (selectionMode) {
      onToggleSelect?.();
      return;
    }
    if (scrollCancelled) {
      cancelScheduledChatRowPark();
      return;
    }
    flushScheduledChatRowPark();
    if (isChatPushPressBlocked()) return;
    prepareChatPushPress();
    if (isChatPushTracked(group.conversationUuid)) {
      markChatOpenTap(group.conversationUuid);
      if (isChatPushHoldingSlide()) requestChatPushPlay(group.conversationUuid);
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

  const beginPress = () => {
    if (selectionMode) return;
    setLit(true);
    scheduleChatRowPark(parkRow);
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
        (pressed || lit) && styles.shellPressed,
      ]}
      onTouchStart={beginPress}
      onTouchCancel={() => setLit(false)}
      onPressIn={beginPress}
      onPressOut={() => setLit(false)}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={LONG_PRESS_MS}
    >
      <View style={[styles.item, group.unreadCount > 0 && styles.itemWithTrailing]}>
        <View style={styles.avatarWrap}>
          <FloraAvatar size={AVATAR_SIZE()} displayName={title} seed={group.conversationUuid} />
          {selectionMode ? (
            <ConversationListSelectionMark selected={selected} avatarDiameter={AVATAR_SIZE()} />
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

const styles = liveGridStyles(() => StyleSheet.create({
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
    paddingBottom: floraSpacing.grid * 2 - sPx(2),
    paddingLeft: floraSpacing.grid,
    paddingRight: CONTENT_INSET_RIGHT_FROM_SCREEN(),
  },
  itemWithTrailing: {
    paddingRight: floraSpacing.gridFine,
  },
  avatarWrap: {
    position: "relative",
    width: AVATAR_SIZE(),
    height: AVATAR_SIZE(),
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: floraSpacing.gridFine,
  },
  name: {
    color: floraColors.whiteTemplate,
    fontSize: kegl(15),
    fontWeight: "300",
    letterSpacing: tracking(0.45),
    lineHeight: 4 * floraSpacing.gridFine,
  },
  preview: {
    color: floraColors.gray,
    fontSize: kegl(15),
    fontWeight: "300",
    letterSpacing: tracking(0.45),
    lineHeight: 4 * floraSpacing.gridFine,
  },
  trailing: {
    width: HEADER_TRAILING_ICON_SLOT(),
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
    borderRadius: sPx(11),
    backgroundColor: "rgba(164, 209, 138, 0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#10200e",
    fontSize: kegl(13),
    fontWeight: "300",
    letterSpacing: tracking(0.39),
  },
}));
