import { liveGridStyles } from "@/lib/liveGridStyles";
import type { MsgConversationDto } from "@flora/client-core/contracts";
import { sharedPresenceStore } from "@flora/client-core/presence";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ConversationListSelectionMark } from "@/components/messages/ConversationListSelectionMark";
import { OnlineStatusDot } from "@/components/messages/OnlineStatusDot";
import { warmParkedChatAvatars } from "@/lib/chatOpenAvatarWarm";
import {
  warmChatOpenTextLayoutAtTap,
  warmChatOpenThreadAtPressIn,
} from "@/lib/chatOpenLayoutWarm";
import { markChatOpenPark, markChatOpenTap } from "@/lib/chatOpenTrace";
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

const LIST_PREVIEW_MAX_LEN = 80;
const AVATAR_SIZE = () => floraSpacing.grid * 3;
/** Как наполнение поста: padding карточки + contentInsetRight = 25px от края экрана. */
const CONTENT_INSET_RIGHT_FROM_SCREEN = () => floraFeedPost.paddingHorizontal + floraFeedPost.contentInsetRight;
const DECRYPT_FAIL_LABEL = "[ не удалось расшифровать ]";
const LONG_PRESS_MS = 350;
/** Как `iconButton` / «+» в TabScreenSearchHeader — центр бейджа под «+». */
const HEADER_TRAILING_ICON_SLOT = () => 3 * floraSpacing.grid;

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
  /** Режим мультивыбора (TG-like). */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onEnterSelect?: () => void;
};

export function ConversationListRow({
  item,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onEnterSelect,
}: Props) {
  const displayName = item.otherDisplayName || item.otherUsername;
  const username = item.otherUsername.replace(/^@+/, "") || "…";
  const preview = formatConversationPreview(item, item.preview);
  const [presenceTick, setPresenceTick] = useState(0);
  const [lit, setLit] = useState(false);
  useEffect(() => sharedPresenceStore.subscribe(() => setPresenceTick((n) => n + 1)), []);
  void presenceTick;
  const overlay = sharedPresenceStore.overlayOnline(
    item.otherUserUuid,
    item.otherUserIsOnline,
    item.otherUserLastSeenAt,
  );

  const threadParams = {
    conversationUuid: item.conversationUuid,
    otherUserUuid: item.otherUserUuid,
    otherDisplayName: item.otherDisplayName,
    otherUsername: item.otherUsername,
    otherAvatarUuid: item.otherAvatarUuid ?? "",
    otherAccountBlocked: item.otherAccountBlocked ? "1" : "0",
    otherUserIsOnline: overlay.isOnline ? "1" : "0",
    otherUserLastSeenAt: overlay.lastSeenAt ?? "",
  };

  const pushThread = () => {
    router.push({
      pathname: "/(tabs)/messages/[conversationUuid]",
      params: threadParams,
    });
  };

  const openChat = () => {
    // Reduce motion и пути без парковки: экран встаёт сразу, без ожидания окна.
    armChatPushEnter();
    markChatOpenTap(item.conversationUuid);
    warmChatOpenTextLayoutAtTap({
      kind: "dm",
      conversationUuid: item.conversationUuid,
      otherUserUuid: item.otherUserUuid,
    });
    pushThread();
  };

  const parkRow = () => {
    warmChatOpenThreadAtPressIn({
      kind: "dm",
      conversationUuid: item.conversationUuid,
      otherUserUuid: item.otherUserUuid,
    });
    void warmParkedChatAvatars([item.otherAvatarUuid]);
    const parked = parkChatPush({
      params: threadParams,
      navigate: pushThread,
    });
    if (parked === "parked") markChatOpenPark(item.conversationUuid);
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
    if (isChatPushTracked(item.conversationUuid)) {
      markChatOpenTap(item.conversationUuid);
      if (isChatPushHoldingSlide()) requestChatPushPlay(item.conversationUuid);
      return;
    }
    openChat();
  };

  /** Подсветка в кадр касания. Монтаж треда — на следующем кадре, не в этом. */
  const beginPress = () => {
    if (selectionMode) return;
    setLit(true);
    scheduleChatRowPark(parkRow);
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
            ? `Снять выбор — ${displayName}`
            : `Выбрать чат — ${displayName}`
          : `Открыть чат с ${displayName}`
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
      <View style={[styles.item, item.unreadCount > 0 && styles.itemWithTrailing]}>
        <View style={styles.avatarWrap}>
          <FloraAvatar
            size={AVATAR_SIZE()}
            avatarUuid={item.otherAvatarUuid}
            displayName={displayName}
            username={item.otherUsername}
            seed={item.otherUserUuid ?? item.otherUsername}
            accountBlocked={item.otherAccountBlocked}
          />
          {selectionMode ? (
            <ConversationListSelectionMark selected={selected} avatarDiameter={AVATAR_SIZE()} />
          ) : (
            <OnlineStatusDot
              key={item.otherUserUuid}
              identityKey={item.otherUserUuid}
              online={overlay.isOnline}
              avatarDiameter={AVATAR_SIZE()}
            />
          )}
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
      </View>

      {item.unreadCount > 0 ? (
        <View style={styles.trailing}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{item.unreadCount > 99 ? "99+" : item.unreadCount}</Text>
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

export function CONVERSATION_ROW_ESTIMATED_HEIGHT() {
  return AVATAR_SIZE() + (floraSpacing.grid * 2 - 1) + (floraSpacing.grid * 2 - sPx(2));
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
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: floraSpacing.gridFine * 2,
    minWidth: 0,
  },
  name: {
    flexShrink: 1,
    color: floraColors.whiteTemplate,
    fontSize: kegl(15),
    fontWeight: "300",
    letterSpacing: tracking(0.45),
    lineHeight: 4 * floraSpacing.gridFine,
  },
  handle: {
    flexShrink: 0,
    color: floraColors.gray,
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
