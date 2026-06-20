import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ChatMessageImageCollage } from "@/components/messages/ChatMessageImageCollage";
import { ChatVoiceMessageCard } from "@/components/messages/ChatVoiceMessageCard";
import type { FscpImageBlock, FscpVoiceBlock } from "@flora/client-core/fscp";
import { ChatMessageBubbleTime } from "@/components/messages/ChatMessageBubbleTime";
import { ChatMessageBubbleTextBody } from "@/components/messages/ChatMessageBubbleTextBody";
import { formatChatTime } from "@/lib/formatChatTime";
import { messageDeliveryState } from "@/lib/messageDeliveryState";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  useWindowDimensions,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import type { ChatPeerInfo } from "./ChatThreadHeader";

export type ThreadBubbleItem = {
  messageUuid: string;
  text: string;
  imageBlocks: FscpImageBlock[];
  voiceBlock?: FscpVoiceBlock;
  isFromMe: boolean;
  createdAt: string;
  decryptState: "ok" | "decrypting" | "failed";
  isRead?: boolean;
  sendStatus?: "sending";
};
type Props = {
  message: ThreadBubbleItem;
  peer: ChatPeerInfo;
  showPeerAvatar: boolean;
  isPeerIndented: boolean;
  showDeleteAction?: boolean;
  onLongPressOwn?: () => void;
};

const DECRYPT_FAIL_LABEL = "[ не удалось расшифровать ]";

function PhotoTimePill({
  label,
  deliveryState,
  receiptColor,
}: {
  label: string;
  deliveryState: ReturnType<typeof messageDeliveryState>;
  receiptColor: string;
}) {
  return (
    <View style={styles.photoTimePill} pointerEvents="none">
      <ChatMessageBubbleTime
        timeLabel={label}
        deliveryState={deliveryState}
        timeStyle={styles.photoTimeText}
        receiptColor={receiptColor}
      />
    </View>
  );
}

function photoTailStyle(isFromMe: boolean): ViewStyle {
  return isFromMe
    ? {
        borderRadius: floraMessages.bubbleRadius,
        borderBottomRightRadius: floraMessages.bubbleTailRadius,
      }
    : {
        borderRadius: floraMessages.bubbleRadius,
        borderBottomLeftRadius: floraMessages.bubbleTailRadius,
      };
}

function maxPhotoBubbleWidth(
  screenWidth: number,
  isFromMe: boolean,
  showPeerAvatar: boolean,
  isPeerIndented: boolean,
): number {
  if (screenWidth <= 0) return floraMessages.photoBubbleWidth;

  const horizontalPad = floraSpacing.grid * 2;
  const peerInset =
    !isFromMe && (showPeerAvatar || isPeerIndented)
      ? floraMessages.peerBubbleAvatarSize + floraSpacing.grid
      : 0;
  const maxByRatio = Math.floor(screenWidth * floraMessages.bubbleMaxWidthRatio);
  const maxByRow = screenWidth - horizontalPad - peerInset;
  return Math.max(0, Math.min(floraMessages.photoBubbleWidth, maxByRatio, maxByRow));
}

function maxVoiceBubbleWidth(
  screenWidth: number,
  isFromMe: boolean,
  showPeerAvatar: boolean,
  isPeerIndented: boolean,
): number {
  if (screenWidth <= 0) return floraMessages.voiceBubbleWidth;

  const horizontalPad = floraSpacing.grid * 2;
  const peerInset =
    !isFromMe && (showPeerAvatar || isPeerIndented)
      ? floraMessages.peerBubbleAvatarSize + floraSpacing.grid
      : 0;
  const maxByRatio = Math.floor(screenWidth * floraMessages.bubbleMaxWidthRatio);
  const maxByRow = screenWidth - horizontalPad - peerInset;
  return Math.max(0, Math.min(floraMessages.voiceBubbleWidth, maxByRatio, maxByRow));
}

function MessageBubbleColumn({
  anchorStyle,
  onLayout,
  isFromMe,
  selected,
  onLongPressOwn,
  children,
}: {
  anchorStyle: ViewStyle | ViewStyle[];
  onLayout?: (event: LayoutChangeEvent) => void;
  isFromMe: boolean;
  selected?: boolean;
  onLongPressOwn?: () => void;
  children: ReactNode;
}) {
  return (
    <View style={anchorStyle} onLayout={onLayout}>
      <Pressable
        disabled={!isFromMe || !onLongPressOwn}
        onLongPress={onLongPressOwn}
        delayLongPress={400}
        style={selected ? styles.bubbleSelected : undefined}
      >
        {children}
      </Pressable>
    </View>
  );
}

export const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  peer,
  showPeerAvatar,
  isPeerIndented,
  showDeleteAction,
  onLongPressOwn,
}: Props) {
  const { width: screenWidth } = useWindowDimensions();
  const maxPhotoWidth = useMemo(
    () => maxPhotoBubbleWidth(screenWidth, message.isFromMe, showPeerAvatar, isPeerIndented),
    [screenWidth, message.isFromMe, showPeerAvatar, isPeerIndented],
  );
  const maxVoiceWidth = useMemo(
    () => maxVoiceBubbleWidth(screenWidth, message.isFromMe, showPeerAvatar, isPeerIndented),
    [screenWidth, message.isFromMe, showPeerAvatar, isPeerIndented],
  );
  const [anchorWidth, setAnchorWidth] = useState(0);

  const onAnchorLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    if (next > 0) {
      setAnchorWidth((prev) => (prev === next ? prev : next));
    }
  }, []);

  const displayName = peer.otherDisplayName || peer.otherUsername || "Пользователь";
  const body =
    message.decryptState === "decrypting"
      ? "Расшифровка…"
      : message.decryptState === "failed"
        ? DECRYPT_FAIL_LABEL
        : message.text;

  const timeLabel = formatChatTime(message.createdAt);
  const deliveryState = messageDeliveryState(message);
  const receiptColor = message.isFromMe ? "rgba(242, 244, 246, 0.78)" : floraColors.gray;
  const inlineTimeStyle = [styles.timeInline, message.isFromMe ? styles.timeMe : styles.timeThem];
  const imageBlocks = message.imageBlocks ?? [];
  const voiceBlock = message.voiceBlock;
  const hasVoice = voiceBlock != null;
  const hasImages = imageBlocks.length > 0;
  const hasText = body.trim().length > 0;
  const voiceOnly = hasVoice && !hasText && !hasImages;
  const voiceWithCaption = hasVoice && hasText;
  const photoOnly = hasImages && !hasText;
  const photoCollage = imageBlocks.length >= 2;
  const collageWithCaption = photoCollage && hasText;
  const singleWithCaption = hasImages && hasText && !photoCollage;
  const fixedPhotoWidth = photoCollage || singleWithCaption;

  const mediaWidth =
    fixedPhotoWidth && anchorWidth > 0
      ? Math.min(anchorWidth, maxPhotoWidth)
      : maxPhotoWidth;

  const wrapStyle = [
    styles.wrap,
    message.isFromMe ? styles.wrapMe : styles.wrapThem,
    !message.isFromMe && isPeerIndented ? styles.wrapIndented : null,
  ];

  const anchorStyle = [
    styles.bubbleAnchor,
    !message.isFromMe ? styles.bubbleAnchorThem : null,
    { maxWidth: maxPhotoWidth },
    fixedPhotoWidth && message.isFromMe ? { width: maxPhotoWidth } : null,
    fixedPhotoWidth && !message.isFromMe ? styles.bubbleAnchorThemFlex : null,
  ];

  if (!hasImages && !hasVoice) {
    return (
      <View style={wrapStyle}>
        {!message.isFromMe && showPeerAvatar ? (
          <View style={styles.peerAvatarSlot}>
            <FloraAvatar
              size={floraMessages.peerBubbleAvatarSize}
              avatarUuid={peer.otherAvatarUuid}
              displayName={displayName}
              username={peer.otherUsername}
              seed={peer.otherUserUuid}
            />
          </View>
        ) : null}
        <MessageBubbleColumn
          anchorStyle={anchorStyle}
          isFromMe={message.isFromMe}
          selected={showDeleteAction}
          onLongPressOwn={onLongPressOwn}
        >
          <View style={[styles.bubble, message.isFromMe ? styles.bubbleMe : styles.bubbleThem]}>
            <ChatMessageBubbleTextBody
              body={body}
              timeLabel={timeLabel}
              deliveryState={deliveryState}
              bodyStyle={[styles.body, message.isFromMe ? styles.bodyMe : styles.bodyThem]}
              timeStyle={inlineTimeStyle}
              receiptColor={receiptColor}
            />
          </View>
        </MessageBubbleColumn>
      </View>
    );
  }

  if (hasVoice && !hasImages) {
    return (
      <View style={wrapStyle}>
        {!message.isFromMe && showPeerAvatar ? (
          <View style={styles.peerAvatarSlot}>
            <FloraAvatar
              size={floraMessages.peerBubbleAvatarSize}
              avatarUuid={peer.otherAvatarUuid}
              displayName={displayName}
              username={peer.otherUsername}
              seed={peer.otherUserUuid}
            />
          </View>
        ) : null}
        <MessageBubbleColumn
          anchorStyle={[
            styles.bubbleAnchor,
            !message.isFromMe ? styles.bubbleAnchorThem : null,
            { maxWidth: maxVoiceWidth },
          ]}
          isFromMe={message.isFromMe}
          selected={showDeleteAction}
          onLongPressOwn={onLongPressOwn}
        >
          <View
            style={[
              styles.bubble,
              message.isFromMe ? styles.bubbleMe : styles.bubbleThem,
              voiceOnly ? styles.bubbleVoiceOnly : styles.bubbleVoiceWithMedia,
              voiceOnly ? { width: maxVoiceWidth } : null,
            ]}
          >
            <View style={voiceOnly ? styles.voiceCardSlot : null}>
              <ChatVoiceMessageCard
                voiceBlock={voiceBlock}
                durationMs={voiceBlock.durationMs}
                waveform={voiceBlock.waveform}
                isFromMe={message.isFromMe}
              />
            </View>
            {voiceWithCaption ? (
              <View style={styles.voiceCaptionBlock}>
                <ChatMessageBubbleTextBody
                  body={body}
                  timeLabel={timeLabel}
                  deliveryState={deliveryState}
                  bodyStyle={[styles.body, message.isFromMe ? styles.bodyMe : styles.bodyThem]}
                  timeStyle={inlineTimeStyle}
                  receiptColor={receiptColor}
                />
              </View>
            ) : null}
            {voiceOnly ? (
              <ChatMessageBubbleTime
                timeLabel={timeLabel}
                deliveryState={deliveryState}
                timeStyle={[
                  styles.voiceBubbleTime,
                  message.isFromMe ? styles.voiceBubbleTimeMe : styles.voiceBubbleTimeThem,
                ]}
                receiptColor={receiptColor}
                containerStyle={styles.voiceTimeRow}
              />
            ) : null}
          </View>
        </MessageBubbleColumn>
      </View>
    );
  }

  const barePhoto = photoOnly || collageWithCaption;
  const bubbleStyles = [
    styles.bubble,
    styles.bubblePhoto,
    fixedPhotoWidth ? styles.bubblePhotoFill : null,
    barePhoto ? styles.bubblePhotoBare : null,
    singleWithCaption ? (message.isFromMe ? styles.bubbleMe : styles.bubbleThem) : null,
  ];

  const mediaTailStyle = photoOnly ? photoTailStyle(message.isFromMe) : null;
  const mediaRadiusStyle =
    photoCollage && hasText
      ? styles.photoMediaCollageCaption
      : photoCollage && photoOnly
        ? [styles.photoMediaCollageOnly, mediaTailStyle]
        : photoOnly
          ? mediaTailStyle
          : null;

  return (
    <View style={wrapStyle}>
      {!message.isFromMe && showPeerAvatar ? (
        <View style={styles.peerAvatarSlot}>
          <FloraAvatar
            size={floraMessages.peerBubbleAvatarSize}
            avatarUuid={peer.otherAvatarUuid}
            displayName={displayName}
            username={peer.otherUsername}
            seed={peer.otherUserUuid}
          />
        </View>
      ) : null}
      <MessageBubbleColumn
        anchorStyle={anchorStyle}
        onLayout={fixedPhotoWidth ? onAnchorLayout : undefined}
        isFromMe={message.isFromMe}
        selected={showDeleteAction}
        onLongPressOwn={onLongPressOwn}
      >
        <View style={bubbleStyles}>
          <View
            style={[
              styles.photoMedia,
              fixedPhotoWidth ? styles.photoMediaFill : null,
              mediaRadiusStyle,
            ]}
          >
            <ChatMessageImageCollage
              blocks={imageBlocks}
              photoOnly={photoOnly}
              hasCaption={hasText}
              isFromMe={message.isFromMe}
              containerWidth={mediaWidth}
            />
            {photoOnly ? (
              <PhotoTimePill
                label={timeLabel}
                deliveryState={deliveryState}
                receiptColor="rgba(242, 244, 246, 0.96)"
              />
            ) : null}
          </View>
          {hasText ? (
            <View
              style={[
                styles.photoCaption,
                message.isFromMe ? styles.photoCaptionMe : styles.photoCaptionThem,
                photoCollage ? styles.photoCaptionAfterCollage : null,
              ]}
            >
              <ChatMessageBubbleTextBody
                body={body}
                timeLabel={timeLabel}
                deliveryState={deliveryState}
                bodyStyle={[styles.body, message.isFromMe ? styles.bodyMe : styles.bodyThem]}
                timeStyle={inlineTimeStyle}
                receiptColor={receiptColor}
              />
            </View>
          ) : null}
        </View>
      </MessageBubbleColumn>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    width: "100%",
    paddingHorizontal: floraSpacing.grid,
    marginBottom: floraMessages.bubbleRowGap,
  },
  wrapMe: {
    justifyContent: "flex-end",
  },
  wrapThem: {
    gap: floraSpacing.grid,
  },
  wrapIndented: {
    paddingLeft: floraSpacing.grid + floraMessages.peerBubbleAvatarSize + floraSpacing.grid,
  },
  peerAvatarSlot: {
    width: floraMessages.peerBubbleAvatarSize,
    flexShrink: 0,
  },
  bubbleAnchor: {
    flexShrink: 1,
    minWidth: 0,
  },
  bubbleAnchorThem: {
    alignItems: "flex-start",
  },
  bubbleAnchorThemFlex: {
    flex: 1,
    minWidth: 0,
  },
  bubbleSelected: {
    opacity: 0.92,
  },
  bubble: {
    padding: floraMessages.bubblePadding,
    borderRadius: floraMessages.bubbleRadius,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  bubbleMe: {
    backgroundColor: floraColors.greenDark,
    borderBottomRightRadius: floraMessages.bubbleTailRadius,
  },
  bubbleThem: {
    backgroundColor: floraMessages.themBubbleBg,
    borderBottomLeftRadius: floraMessages.bubbleTailRadius,
  },
  bubblePhoto: {
    padding: 0,
    overflow: "hidden",
  },
  bubblePhotoFill: {
    width: "100%",
    alignSelf: "stretch",
  },
  bubblePhotoBare: {
    backgroundColor: "transparent",
    shadowOpacity: 0,
    elevation: 0,
  },
  photoMedia: {
    position: "relative",
    overflow: "hidden",
  },
  photoMediaFill: {
    width: "100%",
  },
  photoMediaCollageOnly: {
    overflow: "hidden",
  },
  photoMediaCollageCaption: {
    borderTopLeftRadius: floraMessages.composeRadius,
    borderTopRightRadius: floraMessages.composeRadius,
    overflow: "hidden",
  },
  photoTimePill: {
    position: "absolute",
    right: floraSpacing.gridFine * 2,
    bottom: floraSpacing.gridFine * 2,
    paddingHorizontal: floraSpacing.gridFine * 2,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  photoTimeText: {
    fontSize: floraMessages.bubbleTimeFontSize,
    color: "rgba(242, 244, 246, 0.96)",
  },
  photoCaption: {
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    gap: floraSpacing.gridFine,
  },
  photoCaptionMe: {
    backgroundColor: floraColors.greenDark,
    borderBottomRightRadius: floraMessages.bubbleTailRadius,
  },
  photoCaptionThem: {
    backgroundColor: floraMessages.themBubbleBg,
    borderBottomLeftRadius: floraMessages.bubbleTailRadius,
  },
  photoCaptionAfterCollage: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
  },
  voiceCardSlot: {
    height: floraSpacing.grid * 3,
    minHeight: floraSpacing.grid * 3,
    justifyContent: "center",
  },
  bubbleVoiceOnly: {
    minHeight: 70,
    paddingTop: 8,
    paddingBottom: 8,
    position: "relative",
  },
  bubbleVoiceWithMedia: {
    paddingVertical: floraSpacing.gridFine + 1,
    gap: floraSpacing.gridFine,
  },
  voiceCaptionBlock: {
    paddingTop: floraSpacing.gridFine,
  },
  voiceBubbleTime: {
    fontSize: floraMessages.bubbleTimeFontSize,
    textAlign: "right",
    opacity: 0.85,
  },
  voiceBubbleTimeMe: {
    color: "rgba(242, 244, 246, 0.78)",
  },
  voiceBubbleTimeThem: {
    color: floraMessages.themBubbleTime,
  },
  voiceTimeRow: {
    position: "absolute",
    right: floraSpacing.gridFine * 2,
    bottom: floraSpacing.gridFine + 1,
  },
  body: {
    fontSize: floraMessages.bubbleFontSize,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: floraMessages.bubbleLineHeight,
  },
  bodyMe: {
    color: floraColors.whiteTemplate,
  },
  bodyThem: {
    color: floraMessages.themBubbleText,
  },
  timeInline: {
    fontSize: floraMessages.bubbleTimeFontSize,
    lineHeight: 18,
    opacity: 0.85,
  },
  timeMe: {
    color: floraColors.whiteTemplate,
  },
  timeThem: {
    color: floraMessages.themBubbleTime,
  },
});
