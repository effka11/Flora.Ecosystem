import { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { FloraAvatar } from "@/components/FloraAvatar";
import { ChatMessageImageCollage } from "@/components/messages/ChatMessageImageCollage";
import { ChatVoiceMessageCard } from "@/components/messages/ChatVoiceMessageCard";
import type { FscpImageBlock, FscpMessageReplyRef, FscpVoiceBlock } from "@flora/client-core/fscp";
import { ChatMessageBubbleTime } from "@/components/messages/ChatMessageBubbleTime";
import { ChatMessageBubbleTextBody } from "@/components/messages/ChatMessageBubbleTextBody";
import { ChatMessageReplyQuote } from "@/components/messages/ChatMessageReplyQuote";
import type { BubbleAnchorRect } from "@/components/messages/MessageBubbleMoreMenu";
import { MessageBubbleMenuDock } from "@/components/messages/MessageBubbleMoreMenu";
import { formatChatTime } from "@/lib/formatChatTime";
import { messageDeliveryState } from "@/lib/messageDeliveryState";
import {
  maxPhotoBubbleWidth,
  maxTextBubbleInnerWidth,
  maxTextBubbleWidth,
  maxVoiceBubbleWidth,
  photoCaptionInnerWidth,
  voiceCaptionInnerWidth,
} from "@/lib/messageBubbleLayout";
import {
  messageBubbleBodyTextMetrics,
  messageBubbleTimeTextMetrics,
} from "@/lib/messageBubbleTextStyle";
import {
  bubbleAnchorFromPress,
  readMenuPressCoords,
  type MenuPressCoords,
} from "@/lib/messageBubbleMoreMenuLayout";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { FRANKING_MISSING_RECEIPT_WARNING } from "@flora/client-core/display";
import {
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Pressable } from "react-native-gesture-handler";
import type { ChatPeerInfo } from "./ChatThreadHeader";

export type ThreadBubbleItem = {
  messageUuid: string;
  /**
   * Стабильный ключ строки для FlashList / birth: у optimistic = temp uuid,
   * после ACK остаётся тем же, пока `messageUuid` становится серверным.
   */
  clientMessageKey?: string;
  text: string;
  previewText: string;
  imageBlocks: FscpImageBlock[];
  voiceBlock?: FscpVoiceBlock;
  replyTo?: FscpMessageReplyRef;
  isFromMe: boolean;
  createdAt: string;
  decryptState: "ok" | "decrypting" | "failed";
  isRead?: boolean;
  sendStatus?: "sending";
  /** Group chats: sender for peer-run split + avatar roster lookup. */
  senderUserUuid?: string | null;
  missingFrankReceipt?: boolean;
};
type Props = {
  message: ThreadBubbleItem;
  peer: ChatPeerInfo;
  showPeerAvatar: boolean;
  isPeerIndented: boolean;
  /** Пузырь внутри peer-группы: без аватара/indent, ширина как с reserved peer column. */
  inPeerGroup?: boolean;
  /**
   * Сообщение приходит аргументом, чтобы родитель передавал один стабильный
   * обработчик на все пузыри: инлайн-замыкание на каждый рендер ломало memo,
   * и любое обновление экрана перерисовывало всю ленту.
   */
  onPress?: (message: ThreadBubbleItem, anchor: BubbleAnchorRect) => void;
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

function MessageBubbleColumn({
  tapLaneStyle,
  anchorStyle,
  onPress,
  messageUuid,
  isFromMe,
  /** Voice play sits inside the lane — use long-press for the bubble menu so it
   *  does not steal the play button's short press (nested Pressable + scaleY list). */
  menuActivation = "press",
  children,
  footer,
}: {
  tapLaneStyle: StyleProp<ViewStyle>;
  anchorStyle: StyleProp<ViewStyle>;
  onPress?: (anchor: BubbleAnchorRect) => void;
  messageUuid: string;
  isFromMe: boolean;
  menuActivation?: "press" | "longPress";
  children: ReactNode;
  footer?: ReactNode;
}) {
  const touchRef = useRef<MenuPressCoords | null>(null);
  const yogaHeightRef = useRef(0);
  const captureTouch = useCallback((event: unknown) => {
    const coords = readMenuPressCoords(event);
    if (coords != null) touchRef.current = coords;
  }, []);
  const handlePress = useCallback(
    (event?: unknown) => {
      onPress?.(bubbleAnchorFromPress(event, yogaHeightRef.current, touchRef.current));
    },
    [onPress],
  );

  return (
    <View style={[styles.tapLane, tapLaneStyle]} pointerEvents="box-none">
      <View style={anchorStyle} pointerEvents="box-none">
        <MessageBubbleMenuDock messageUuid={messageUuid} isFromMe={isFromMe}>
          <Pressable
            disabled={!onPress}
            onLayout={(e) => {
              yogaHeightRef.current = e.nativeEvent.layout.height;
            }}
            onPressIn={onPress ? captureTouch : undefined}
            onPress={menuActivation === "press" && onPress ? handlePress : undefined}
            onLongPress={menuActivation === "longPress" && onPress ? handlePress : undefined}
            delayLongPress={280}
          >
            {children}
          </Pressable>
        </MessageBubbleMenuDock>
      </View>
      {footer}
    </View>
  );
}

function FrankingReceiptWarning({ show }: { show?: boolean }) {
  if (!show) return null;
  return <Text style={styles.frankingReceiptWarn}>{FRANKING_MISSING_RECEIPT_WARNING}</Text>;
}

export const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  peer,
  showPeerAvatar,
  isPeerIndented,
  inPeerGroup = false,
  onPress,
}: Props) {
  const { width: screenWidth } = useWindowDimensions();
  const layoutCtx = useMemo(
    () => ({
      screenWidth,
      isFromMe: message.isFromMe,
      // В группе аватар снаружи — для ширины резервируем колонку как при indent/avatar.
      showPeerAvatar: inPeerGroup ? false : showPeerAvatar,
      isPeerIndented: inPeerGroup ? true : isPeerIndented,
    }),
    [screenWidth, message.isFromMe, showPeerAvatar, isPeerIndented, inPeerGroup],
  );
  const maxPhotoWidth = useMemo(() => maxPhotoBubbleWidth(layoutCtx), [layoutCtx]);
  const maxVoiceWidth = useMemo(() => maxVoiceBubbleWidth(layoutCtx), [layoutCtx]);
  const maxTextWidth = useMemo(() => maxTextBubbleWidth(layoutCtx), [layoutCtx]);
  const textInnerWidth = useMemo(() => maxTextBubbleInnerWidth(layoutCtx), [layoutCtx]);
  const voiceCaptionInner = useMemo(() => voiceCaptionInnerWidth(layoutCtx), [layoutCtx]);
  const photoCaptionInner = useMemo(() => photoCaptionInnerWidth(layoutCtx), [layoutCtx]);
  const voiceYogaHeightRef = useRef(0);

  const displayName = peer.otherDisplayName || peer.otherUsername || "Пользователь";
  // Анкорная обёртка живёт внутри memo-границы — её пересоздание дёшево.
  const pressBubble = onPress
    ? (anchor: BubbleAnchorRect) => onPress(message, anchor)
    : undefined;
  // Чужие decrypting режет лента; свои могут показать статус. Не рисуем peer-заглушку.
  if (!message.isFromMe && message.decryptState === "decrypting") {
    return null;
  }
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

  const replyQuote =
    message.replyTo != null ? (
      <ChatMessageReplyQuote reply={message.replyTo} isFromMe={message.isFromMe} />
    ) : null;

  const wrapStyle = [
    styles.wrap,
    message.isFromMe ? styles.wrapMe : styles.wrapThem,
    !message.isFromMe && isPeerIndented && !inPeerGroup ? styles.wrapIndented : null,
    inPeerGroup ? styles.wrapInPeerGroup : null,
  ];
  const showAvatar = !message.isFromMe && showPeerAvatar && !inPeerGroup;

  const bubbleColumnProps = {
    onPress: pressBubble,
    tapLaneStyle: message.isFromMe ? styles.tapLaneMe : styles.tapLaneThem,
    messageUuid: message.messageUuid,
    isFromMe: message.isFromMe,
  };

  const anchorStyle = [
    styles.bubbleAnchor,
    !message.isFromMe ? styles.bubbleAnchorThem : null,
    { maxWidth: maxPhotoWidth },
    fixedPhotoWidth ? { width: maxPhotoWidth } : null,
  ];

  if (!hasImages && !hasVoice) {
    const textAnchorStyle = [
      styles.bubbleAnchor,
      !message.isFromMe ? styles.bubbleAnchorThem : null,
      { maxWidth: maxTextWidth },
    ];

    return (
      <View style={wrapStyle}>
        {showAvatar ? (
          <View style={styles.peerAvatarSlot}>
            <FloraAvatar
              size={floraMessages.peerBubbleAvatarSize}
              avatarUuid={peer.otherAvatarUuid}
              displayName={displayName}
              username={peer.otherUsername}
              seed={peer.otherUserUuid}
              accountBlocked={peer.otherAccountBlocked}
            />
          </View>
        ) : null}
        <MessageBubbleColumn
          anchorStyle={textAnchorStyle}
          {...bubbleColumnProps}
          footer={<FrankingReceiptWarning show={message.missingFrankReceipt} />}
        >
          {/* Обычный View, не Reanimated: анимированных стилей у пузыря нет
              (подъём ленты общий), а обёртка createAnimatedComponent давала
              лишний вес на монтаж каждой ячейки — самой дорогой фазе открытия. */}
          <View
            collapsable={false}
            style={[
              styles.bubble,
              styles.bubbleTextInline,
              message.isFromMe ? styles.bubbleMe : styles.bubbleThem,
            ]}
          >
            {replyQuote}
            <ChatMessageBubbleTextBody
              body={body}
              timeLabel={timeLabel}
              deliveryState={deliveryState}
              maxBubbleInnerWidthPx={textInnerWidth}
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
    const openVoiceMenu = (event?: unknown) => {
      pressBubble?.(bubbleAnchorFromPress(event, voiceYogaHeightRef.current));
    };
    return (
      <View style={wrapStyle}>
        {showAvatar ? (
          <View style={styles.peerAvatarSlot}>
            <FloraAvatar
              size={floraMessages.peerBubbleAvatarSize}
              avatarUuid={peer.otherAvatarUuid}
              displayName={displayName}
              username={peer.otherUsername}
              seed={peer.otherUserUuid}
              accountBlocked={peer.otherAccountBlocked}
            />
          </View>
        ) : null}
        {/*
          Voice: play button must NOT sit under the bubble-menu Pressable.
          Nested Pressable + inverted FlashList (scaleY) steals short presses.
          Menu opens via long-press on the waveform/time lane only.
        */}
        <View
          style={[
            styles.tapLane,
            message.isFromMe ? styles.tapLaneMe : styles.tapLaneThem,
          ]}
          pointerEvents="box-none"
        >
          <MessageBubbleMenuDock messageUuid={message.messageUuid} isFromMe={message.isFromMe}>
            <View
            collapsable={false}
            onLayout={(e) => {
              voiceYogaHeightRef.current = e.nativeEvent.layout.height;
            }}
            style={[
              styles.bubbleAnchor,
              !message.isFromMe ? styles.bubbleAnchorThem : null,
              { maxWidth: maxVoiceWidth },
              styles.bubble,
              message.isFromMe ? styles.bubbleMe : styles.bubbleThem,
              voiceOnly ? styles.bubbleVoiceOnly : styles.bubbleVoiceWithMedia,
              voiceOnly ? { width: maxVoiceWidth } : null,
            ]}
          >
            {replyQuote}
            <View style={voiceOnly ? styles.voiceCardSlot : null}>
              <ChatVoiceMessageCard
                voiceBlock={voiceBlock}
                durationMs={voiceBlock.durationMs}
                waveform={voiceBlock.waveform}
                isFromMe={message.isFromMe}
                onMenuLongPress={pressBubble ? openVoiceMenu : undefined}
                timeSlot={
                  voiceOnly ? (
                    <ChatMessageBubbleTime
                      timeLabel={timeLabel}
                      deliveryState={deliveryState}
                      timeStyle={[
                        styles.voiceBubbleTime,
                        message.isFromMe ? styles.voiceBubbleTimeMe : styles.voiceBubbleTimeThem,
                      ]}
                      receiptColor={receiptColor}
                      containerStyle={styles.voiceSendTimeRow}
                    />
                  ) : undefined
                }
              />
            </View>
            {voiceWithCaption ? (
              <Pressable
                onLongPress={openVoiceMenu}
                delayLongPress={280}
              >
                <View style={styles.voiceCaptionBlock}>
                  <ChatMessageBubbleTextBody
                    body={body}
                    timeLabel={timeLabel}
                    deliveryState={deliveryState}
                    maxBubbleInnerWidthPx={voiceCaptionInner}
                    bodyStyle={[styles.body, message.isFromMe ? styles.bodyMe : styles.bodyThem]}
                    timeStyle={inlineTimeStyle}
                    receiptColor={receiptColor}
                  />
                </View>
              </Pressable>
            ) : null}
          </View>
          </MessageBubbleMenuDock>
          <FrankingReceiptWarning show={message.missingFrankReceipt} />
        </View>
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
      {showAvatar ? (
        <View style={styles.peerAvatarSlot}>
          <FloraAvatar
            size={floraMessages.peerBubbleAvatarSize}
            avatarUuid={peer.otherAvatarUuid}
            displayName={displayName}
            username={peer.otherUsername}
            seed={peer.otherUserUuid}
            accountBlocked={peer.otherAccountBlocked}
          />
        </View>
      ) : null}
      <MessageBubbleColumn
        anchorStyle={anchorStyle}
        {...bubbleColumnProps}
        footer={<FrankingReceiptWarning show={message.missingFrankReceipt} />}
      >
        <View collapsable={false} style={bubbleStyles}>
          {replyQuote ? (
            <View
              style={[
                styles.photoReplyWrap,
                !photoOnly ? (message.isFromMe ? styles.photoCaptionMe : styles.photoCaptionThem) : null,
                photoCollage && !photoOnly ? styles.photoCaptionAfterCollage : null,
              ]}
            >
              {replyQuote}
            </View>
          ) : null}
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
              containerWidth={maxPhotoWidth}
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
                maxBubbleInnerWidthPx={photoCaptionInner}
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
    overflow: "visible",
  },
  /** Внутри peer-группы: padding/margin на оболочке группы. */
  wrapInPeerGroup: {
    paddingHorizontal: 0,
    marginBottom: 0,
    width: "100%",
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
  /** Зона тапа — почти вся ширина строки; пузырь остаётся по краю. */
  tapLane: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    overflow: "visible",
  },
  tapLaneMe: {
    alignItems: "flex-end",
  },
  tapLaneThem: {
    alignItems: "flex-start",
  },
  bubbleAnchor: {
    flexShrink: 1,
    minWidth: 0,
    overflow: "visible",
  },
  bubbleAnchorThem: {
    alignItems: "flex-start",
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
  /** Однострочник 10+25+10=45px — паритет .messagesBubbleInlineTime; только вертикаль, горизонталь из bubble. */
  bubbleTextInline: {
    paddingTop: floraMessages.bubblePaddingVerticalInline,
    paddingBottom: floraMessages.bubblePaddingVerticalInline,
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
  photoReplyWrap: {
    paddingHorizontal: floraSpacing.grid,
    paddingTop: floraSpacing.gridFine * 2,
    paddingBottom: 0,
  },
  /** Паритет web `.messagesBubbleVoiceOnly .voiceCard` — 3 клетки. */
  voiceCardSlot: {
    height: floraSpacing.grid * 3,
    minHeight: floraSpacing.grid * 3,
    justifyContent: "center",
    flexShrink: 0,
  },
  /**
   * Паритет web `.messagesBubbleVoiceOnly`:
   * padding (grid−1.5)×2 + card 3×grid = 5×grid − 3.
   * Send time on the duration row (like text time ↔ last line).
   */
  bubbleVoiceOnly: {
    height: 5 * floraSpacing.grid - 3,
    minHeight: 5 * floraSpacing.grid - 3,
    paddingTop: floraSpacing.grid - 1.5,
    paddingBottom: floraSpacing.grid - 1.5,
    justifyContent: "flex-start",
    gap: 0,
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
    lineHeight: floraSpacing.grid,
  },
  voiceBubbleTimeMe: {
    color: "rgba(242, 244, 246, 0.78)",
  },
  voiceBubbleTimeThem: {
    color: floraMessages.themBubbleTime,
  },
  voiceSendTimeRow: {
    minHeight: floraSpacing.grid,
    height: floraSpacing.grid,
  },
  // Метрики — из общего источника: ими же мерит offscreen-прогрев замеров.
  body: messageBubbleBodyTextMetrics,
  bodyMe: {
    color: floraColors.whiteTemplate,
  },
  bodyThem: {
    color: floraMessages.themBubbleText,
  },
  frankingReceiptWarn: {
    marginTop: floraSpacing.gridFine,
    maxWidth: "100%",
    fontSize: 12,
    lineHeight: 16,
    color: floraColors.textMuted,
  },
  timeInline: {
    ...messageBubbleTimeTextMetrics,
    opacity: 0.85,
  },
  timeMe: {
    color: floraColors.whiteTemplate,
  },
  timeThem: {
    color: floraMessages.themBubbleTime,
  },
});
