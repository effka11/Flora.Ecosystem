import {
  MESSAGE_RECEIPT_INLINE_RESERVE_PX,
  TIME_INLINE_GAP_PX,
  resolveBubbleTimePlacementFromLineWidths,
  type BubbleTimePlacement,
} from "@flora/client-core/display";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  NativeSyntheticEvent,
  StyleSheet,
  Text,
  TextLayoutEventData,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { ChatMessageBubbleTime } from "@/components/messages/ChatMessageBubbleTime";
import { ChatMessageReadReceipt } from "@/components/messages/ChatMessageReadReceipt";
import type { MessageDeliveryState } from "@/lib/messageDeliveryState";

type Props = {
  body: string;
  timeLabel: string;
  deliveryState: MessageDeliveryState | null;
  maxBubbleInnerWidthPx: number;
  bodyStyle: StyleProp<TextStyle>;
  timeStyle: StyleProp<TextStyle>;
  receiptColor?: string;
};

type InlineMetaRowProps = {
  timeLabel: string;
  timeStyle: StyleProp<TextStyle>;
  deliveryState: MessageDeliveryState | null;
  receiptColor?: string;
  containerStyle?: StyleProp<ViewStyle>;
};

function InlineMetaRow({
  timeLabel,
  timeStyle,
  deliveryState,
  receiptColor,
  containerStyle,
}: InlineMetaRowProps) {
  return (
    <View style={[styles.inlineMetaRow, containerStyle]}>
      <Text style={[timeStyle, deliveryState ? styles.timeLabelWithReceipt : null]}>{timeLabel}</Text>
      {deliveryState ? (
        <ChatMessageReadReceipt state={deliveryState} sentColor={receiptColor} />
      ) : null}
    </View>
  );
}

function resolveLayoutLines(body: string, lines: TextLayoutEventData["lines"]): string[] {
  const texts = lines.map((line) => line.text?.trimEnd() ?? "");
  if (texts.every((text) => text.length === 0) && body.includes("\n")) {
    return body.split("\n");
  }
  if (texts.every((text) => text.length === 0)) {
    return [body];
  }
  return texts;
}

/** Telegram-style: короткий текст + время в одной строке; длинный — время отдельной строкой справа. */
function ChatMessageBubbleTextBodyInner({
  body,
  timeLabel,
  deliveryState,
  maxBubbleInnerWidthPx,
  bodyStyle,
  timeStyle,
  receiptColor,
}: Props) {
  const [placement, setPlacement] = useState<BubbleTimePlacement>("inline");
  const [layoutLines, setLayoutLines] = useState<string[]>([]);
  const [inlineBlockWidthPx, setInlineBlockWidthPx] = useState(0);
  const measureRef = useRef<{ lineWidths?: number[]; timeLabelWidth?: number }>({});

  const receiptReserve = deliveryState ? MESSAGE_RECEIPT_INLINE_RESERVE_PX : 0;

  const tryResolvePlacement = useCallback(() => {
    const { lineWidths, timeLabelWidth } = measureRef.current;
    if (!lineWidths || timeLabelWidth == null || maxBubbleInnerWidthPx <= 0) return;

    const lastLineWidth = lineWidths.at(-1) ?? 0;
    const maxOtherWidth = lineWidths.length > 1 ? Math.max(...lineWidths.slice(0, -1)) : 0;
    const metaWidth = timeLabelWidth + TIME_INLINE_GAP_PX + receiptReserve;
    const nextInlineBlockWidthPx = Math.max(maxOtherWidth, lastLineWidth + metaWidth);

    setPlacement(
      resolveBubbleTimePlacementFromLineWidths(lineWidths, metaWidth, maxBubbleInnerWidthPx),
    );
    setInlineBlockWidthPx(nextInlineBlockWidthPx);
  }, [maxBubbleInnerWidthPx, receiptReserve]);

  useEffect(() => {
    measureRef.current = {};
    setLayoutLines([]);
    setPlacement("inline");
    setInlineBlockWidthPx(0);
  }, [body, timeLabel, maxBubbleInnerWidthPx, deliveryState]);

  const onBodyTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const lines = event.nativeEvent.lines;
      measureRef.current.lineWidths = lines.map((line) => line.width);
      setLayoutLines(resolveLayoutLines(body, lines));
      tryResolvePlacement();
    },
    [body, tryResolvePlacement],
  );

  const onTimeTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const firstLine = event.nativeEvent.lines[0];
      measureRef.current.timeLabelWidth = firstLine?.width ?? 0;
      tryResolvePlacement();
    },
    [tryResolvePlacement],
  );

  const measureSlotStyle = [styles.measureSlot, { width: maxBubbleInnerWidthPx }] as StyleProp<ViewStyle>;

  const renderInlineContent = () => {
    if (layoutLines.length <= 1) {
      return (
        <View style={styles.inlineSingleRow}>
          <Text style={bodyStyle}>{body}</Text>
          <InlineMetaRow
            timeLabel={timeLabel}
            timeStyle={timeStyle}
            deliveryState={deliveryState}
            receiptColor={receiptColor}
          />
        </View>
      );
    }

    const prefixLines = layoutLines.slice(0, -1);
    const lastLine = layoutLines.at(-1) ?? "";

    return (
      <>
        {prefixLines.map((line, index) => (
          <Text key={`prefix-${index}`} style={bodyStyle}>
            {line}
          </Text>
        ))}
        <View
          style={[
            styles.inlineLastRow,
            inlineBlockWidthPx > 0 ? { width: inlineBlockWidthPx } : null,
          ]}
        >
          <Text style={[bodyStyle, styles.inlineLastLineText]}>{lastLine}</Text>
          <InlineMetaRow
            timeLabel={timeLabel}
            timeStyle={timeStyle}
            deliveryState={deliveryState}
            receiptColor={receiptColor}
            containerStyle={styles.inlineMetaRowAnchored}
          />
        </View>
      </>
    );
  };

  return (
    <View style={styles.inlineWrap}>
      <View style={measureSlotStyle} pointerEvents="none">
        <Text style={bodyStyle} onTextLayout={onBodyTextLayout}>
          {body}
        </Text>
      </View>
      <View style={styles.measureSlotTime} pointerEvents="none">
        <Text style={timeStyle} onTextLayout={onTimeTextLayout}>
          {timeLabel}
        </Text>
      </View>

      {placement === "inline" ? (
        renderInlineContent()
      ) : (
        <View style={styles.belowBlock}>
          <Text style={bodyStyle}>{body}</Text>
          <ChatMessageBubbleTime
            timeLabel={timeLabel}
            deliveryState={deliveryState}
            timeStyle={timeStyle}
            receiptColor={receiptColor}
            containerStyle={styles.meta}
          />
        </View>
      )}
    </View>
  );
}

export const ChatMessageBubbleTextBody = memo(ChatMessageBubbleTextBodyInner);

const styles = StyleSheet.create({
  inlineWrap: {
    position: "relative",
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  measureSlot: {
    position: "absolute",
    left: 0,
    top: 0,
    opacity: 0,
    zIndex: -1,
  },
  measureSlotTime: {
    position: "absolute",
    left: 0,
    top: 0,
    opacity: 0,
    zIndex: -1,
  },
  inlineSingleRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    flexShrink: 1,
    maxWidth: "100%",
  },
  inlineLastRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    maxWidth: "100%",
  },
  inlineLastLineText: {
    flexShrink: 1,
  },
  inlineMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: TIME_INLINE_GAP_PX,
    flexShrink: 0,
  },
  inlineMetaRowAnchored: {
    marginLeft: "auto",
    flexShrink: 0,
  },
  timeLabelWithReceipt: {
    transform: [{ translateY: 1 }],
  },
  belowBlock: {
    maxWidth: "100%",
    gap: 2,
  },
  meta: {
    alignSelf: "flex-end",
  },
});

