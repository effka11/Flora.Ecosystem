import { memo } from "react";
import { FloraAvatar } from "@/components/FloraAvatar";
import {
  ChatMessageBubble,
  type ThreadBubbleItem,
} from "@/components/messages/ChatMessageBubble";
import { ChatMessageBirthHost } from "@/components/messages/ChatMessageBirthHost";
import type { BubbleAnchorRect } from "@/components/messages/MessageBubbleMoreMenu";
import type { ChatPeerInfo } from "@/components/messages/ChatThreadHeader";
import { floraMessages, floraSpacing } from "@/lib/theme";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { type AnimatedStyle } from "react-native-reanimated";

type Props = {
  messages: ThreadBubbleItem[];
  peer: ChatPeerInfo;
  menuTargetUuid: string | null;
  onPress: (message: ThreadBubbleItem, anchor: BubbleAnchorRect) => void;
  onAnchorSync: (messageUuid: string, anchor: BubbleAnchorRect) => void;
  /** Контр-transform к list insertLift — аватар хвоста остаётся в кадре. */
  holdAvatarStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
};

export const ChatPeerMessageGroup = memo(function ChatPeerMessageGroup({
  messages,
  peer,
  menuTargetUuid,
  onPress,
  onAnchorSync,
  holdAvatarStyle,
}: Props) {
  const displayName = peer.otherDisplayName || peer.otherUsername || "Пользователь";

  return (
    <View style={styles.group}>
      <Animated.View style={[styles.avatarSlot, holdAvatarStyle]} pointerEvents="none">
        <FloraAvatar
          size={floraMessages.peerBubbleAvatarSize}
          avatarUuid={peer.otherAvatarUuid}
          displayName={displayName}
          username={peer.otherUsername}
          seed={peer.otherUserUuid}
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
                peer={peer}
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
