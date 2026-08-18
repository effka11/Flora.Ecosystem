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
  messages: ThreadBubbleItem[];
  peer: ChatPeerInfo;
  /** Group roster — when set, avatar resolves by message senderUserUuid. */
  groupMembers?: readonly GroupMember[];
  menuTargetUuid: string | null;
  onPress: (message: ThreadBubbleItem, anchor: BubbleAnchorRect) => void;
  onAnchorSync: (messageUuid: string, anchor: BubbleAnchorRect) => void;
  holdAvatarStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
};

export const ChatPeerMessageGroup = memo(function ChatPeerMessageGroup({
  messages,
  peer,
  groupMembers,
  menuTargetUuid,
  onPress,
  onAnchorSync,
  holdAvatarStyle,
}: Props) {
  const avatarPeer = useMemo((): ChatPeerInfo => {
    if (!groupMembers?.length) return peer;
    const senderUuid =
      messages[messages.length - 1]?.senderUserUuid?.trim() ||
      messages[0]?.senderUserUuid?.trim() ||
      "";
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
  }, [groupMembers, messages, peer]);

  const displayName =
    avatarPeer.otherDisplayName || avatarPeer.otherUsername || "Пользователь";

  return (
    <View style={styles.group}>
      <Animated.View style={[styles.avatarSlot, holdAvatarStyle]} pointerEvents="none">
        <FloraAvatar
          size={floraMessages.peerBubbleAvatarSize}
          avatarUuid={avatarPeer.otherAvatarUuid}
          displayName={displayName}
          username={avatarPeer.otherUsername}
          seed={avatarPeer.otherUserUuid || displayName}
          accountBlocked={avatarPeer.otherAccountBlocked}
        />
      </Animated.View>
      <View style={styles.bubbles}>
        {messages.map((message) => {
          const clientKey = message.clientMessageKey ?? message.messageUuid;
          const isMenuTarget = menuTargetUuid === message.messageUuid;
          return (
            <ChatMessageBirthHost key={clientKey} clientMessageKey={clientKey}>
              <ChatMessageBubble
                message={message}
                peer={avatarPeer}
                showPeerAvatar={false}
                isPeerIndented={false}
                inPeerGroup
                isMenuTarget={isMenuTarget}
                onPress={(anchor) => onPress(message, anchor)}
                onAnchorSync={
                  isMenuTarget ? (anchor) => onAnchorSync(message.messageUuid, anchor) : undefined
                }
              />
            </ChatMessageBirthHost>
          );
        })}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  group: {
    flexDirection: "row",
    alignItems: "flex-end",
    width: "100%",
    paddingHorizontal: floraSpacing.grid,
    marginBottom: floraMessages.bubbleRowGap,
    gap: floraSpacing.grid,
  },
  avatarSlot: {
    width: floraMessages.peerBubbleAvatarSize,
    flexShrink: 0,
  },
  bubbles: {
    flex: 1,
    minWidth: 0,
    maxWidth: "78%",
    gap: floraMessages.bubbleRowGap,
  },
});
