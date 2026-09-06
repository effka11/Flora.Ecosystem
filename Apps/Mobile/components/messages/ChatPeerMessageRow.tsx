import { liveGridStyles } from "@/lib/liveGridStyles";
import { memo, useMemo } from "react";
import { FloraAvatar } from "@/components/FloraAvatar";
import {
  ChatMessageBubble,
  type ThreadBubbleItem,
} from "@/components/messages/ChatMessageBubble";
import { ChatMessageBirthHost } from "@/components/messages/ChatMessageBirthHost";
import type { BubbleAnchorRect } from "@/components/messages/MessageBubbleMoreMenu";
import type { ChatPeerInfo } from "@/components/messages/ChatThreadHeader";
import { findGroupMember } from "@/lib/groupChatMap";
import type { GroupMember } from "@/lib/groupChatTypes";
import { floraMessages, floraSpacing } from "@/lib/theme";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { type AnimatedStyle } from "react-native-reanimated";

type Props = {
  message: ThreadBubbleItem;
  /** Хвост run'а (низ группы) — строка носит аватар; остальные держат отступ. */
  showAvatar: boolean;
  peer: ChatPeerInfo;
  /** Group roster — when set, avatar resolves by message senderUserUuid. */
  groupMembers?: readonly GroupMember[];
  onPress: (message: ThreadBubbleItem, anchor: BubbleAnchorRect) => void;
  holdAvatarStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
};

/**
 * Одна peer-строка плоской ленты (телеграмная модель): пузырь + слот аватара.
 * Раньше весь peer-run был одним компонентом (`ChatPeerMessageGroup`) — один
 * item FlashList монтировал десятки пузырей, виртуализация внутри run'а не
 * работала. Геометрия строки повторяет старую группу пиксель в пиксель:
 * та же колонка аватара, тот же горизонтальный gap, maxWidth 78%,
 * межстрочный отступ = bubbleRowGap (бывший gap колонки/margin группы).
 */
export const ChatPeerMessageRow = memo(function ChatPeerMessageRow({
  message,
  showAvatar,
  peer,
  groupMembers,
  onPress,
  holdAvatarStyle,
}: Props) {
  const senderUuid = message.senderUserUuid?.trim() || "";
  const avatarPeer = useMemo((): ChatPeerInfo => {
    if (!groupMembers?.length) return peer;
    const member = findGroupMember(groupMembers, senderUuid);
    if (!member) {
      return {
        ...peer,
        otherUserUuid: senderUuid || peer.otherUserUuid,
        otherDisplayName: "Участник",
        otherUsername: "",
        otherAvatarUuid: null,
        otherAccountBlocked: false,
      };
    }
    return {
      otherUserUuid: member.userUuid,
      otherUsername: member.username,
      otherDisplayName: member.displayName,
      otherAvatarUuid: member.avatarUuid ?? null,
      otherAccountBlocked: member.accountBlocked,
      otherUserIsOnline: false,
      otherUserLastSeenAt: null,
      conversationUuid: peer.conversationUuid,
    };
  }, [groupMembers, peer, senderUuid]);

  const displayName =
    avatarPeer.otherDisplayName || avatarPeer.otherUsername || "Пользователь";
  const clientKey = message.clientMessageKey ?? message.messageUuid;

  return (
    <View style={styles.row}>
      <Animated.View style={[styles.avatarSlot, holdAvatarStyle]} pointerEvents="none">
        {showAvatar ? (
          <FloraAvatar
            size={floraMessages.peerBubbleAvatarSize}
            avatarUuid={avatarPeer.otherAvatarUuid}
            displayName={displayName}
            username={avatarPeer.otherUsername}
            seed={avatarPeer.otherUserUuid || displayName}
            accountBlocked={avatarPeer.otherAccountBlocked}
          />
        ) : null}
      </Animated.View>
      <View style={styles.bubbleSlot}>
        <ChatMessageBirthHost clientMessageKey={clientKey}>
          <ChatMessageBubble
            message={message}
            peer={avatarPeer}
            showPeerAvatar={false}
            isPeerIndented={false}
            inPeerGroup
            onPress={onPress}
          />
        </ChatMessageBirthHost>
      </View>
    </View>
  );
});

const styles = liveGridStyles(() => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    width: "100%",
    paddingHorizontal: floraSpacing.grid,
    marginBottom: floraMessages.bubbleRowGap,
    gap: floraSpacing.grid,
    overflow: "visible",
  },
  avatarSlot: {
    width: floraMessages.peerBubbleAvatarSize,
    flexShrink: 0,
  },
  bubbleSlot: {
    flex: 1,
    minWidth: 0,
    maxWidth: "78%",
    overflow: "visible",
  },
}));
