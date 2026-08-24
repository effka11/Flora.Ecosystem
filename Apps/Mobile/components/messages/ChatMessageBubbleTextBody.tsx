import { TIME_INLINE_GAP_PX, type BubbleTimePlacement } from "@flora/client-core/display";
import { memo, useCallback, useMemo, useState } from "react";
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
import { resolveBubbleMetaLayout } from "@/lib/messageBubbleLayout";
import type { MessageDeliveryState } from "@/lib/messageDeliveryState";
import {
  getCachedBodyMeasure,
  getCachedTimeLabelWidth,
  setCachedBodyMeasure,
  setCachedTimeLabelWidth,
} from "@/lib/messageTextMeasureCache";

type Props = {
  body: string;
  timeLabel: string;
  deliveryState: MessageDeliveryState | null;
  maxBubbleInnerWidthPx: number;
  bodyStyle: StyleProp<TextStyle>;
  timeStyle: StyleProp<TextStyle>;
  receiptColor?: string;
};

/** Замер помечен текстом и шириной, для которых сделан: устаревший к новому тексту не применяется. */
type BodyMeasure = {
  body: string;
  maxInnerWidthPx: number;
  lineWidths: number[];
  lines: string[];
};

type TimeMeasure = {
  timeLabel: string;
  widthPx: number;
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

function sameBodyMeasure(prev: BodyMeasure | null, next: BodyMeasure): boolean {
  return (
    prev != null &&
    prev.body === next.body &&
    prev.maxInnerWidthPx === next.maxInnerWidthPx &&
    prev.lineWidths.length === next.lineWidths.length &&
    prev.lineWidths.every((width, index) => width === next.lineWidths[index]) &&
    prev.lines.length === next.lines.length &&
    prev.lines.every((line, index) => line === next.lines[index])
  );
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
  const [bodyMeasure, setBodyMeasure] = useState<BodyMeasure | null>(null);
  const [timeMeasure, setTimeMeasure] = useState<TimeMeasure | null>(null);

  const onBodyTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const lines = event.nativeEvent.lines;
      const next: BodyMeasure = {
        body,
        maxInnerWidthPx: maxBubbleInnerWidthPx,
        lineWidths: lines.map((line) => line.width),
        lines: resolveLayoutLines(body, lines),
      };
      setCachedBodyMeasure(body, maxBubbleInnerWidthPx, {
        lineWidths: next.lineWidths,
        lines: next.lines,
      });
      setBodyMeasure((prev) => (sameBodyMeasure(prev, next) ? prev : next));
    },
    [body, maxBubbleInnerWidthPx],
  );

  const onTimeTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const widthPx = event.nativeEvent.lines[0]?.width ?? 0;
      setCachedTimeLabelWidth(timeLabel, widthPx);
      setTimeMeasure((prev) =>
        prev?.timeLabel === timeLabel && prev.widthPx === widthPx ? prev : { timeLabel, widthPx },
      );
    },
    [timeLabel],
  );

  /**
   * The `useState` initializer only runs on mount, so it cannot see a cache
   * entry written after a FlashList cell was created but before it was
   * recycled onto this text: recycling reuses the instance rather than
   * remounting it. Falling back to the cache here, on every render, is what
   * makes a recycled or re-entered cell correct on its first frame.
   */
  const measuredBody =
    bodyMeasure != null && bodyMeasure.body === body && bodyMeasure.maxInnerWidthPx === maxBubbleInnerWidthPx
      ? bodyMeasure
      : getCachedBodyMeasure(body, maxBubbleInnerWidthPx);
  const measuredTimeWidthPx =
    timeMeasure?.timeLabel === timeLabel ? timeMeasure.widthPx : getCachedTimeLabelWidth(timeLabel);
  const hasReceipt = deliveryState != null;

  /** Считаем от замеров, а не от накопленного стейта: смена статуса доставки их не обнуляет. */
  const metaLayout = useMemo(() => {
    if (measuredBody == null || measuredTimeWidthPx == null || maxBubbleInnerWidthPx <= 0) {
      return null;
    }
    return resolveBubbleMetaLayout({
      lineWidths: measuredBody.lineWidths,
      timeLabelWidthPx: measuredTimeWidthPx,
      hasReceipt,
      maxInnerWidthPx: maxBubbleInnerWidthPx,
    });
  }, [measuredBody, measuredTimeWidthPx, hasReceipt, maxBubbleInnerWidthPx]);

  const placement: BubbleTimePlacement = metaLayout?.placement ?? "inline";
  const layoutLines = measuredBody?.lines ?? [];

  /**
   * Скрытые замерные Text-узлы — только пока замера нет (в кэше или стейте).
   * Безусловный вариант рендерил тело КАЖДОГО пузыря дважды + узел времени и
   * давал 1–2 лишних setState на пузырь при монтаже — на открытии чата это
   * была заметная часть стоимости первого коммита ленты. При кэш-хите
   * (повторное открытие, recycle) пузырь монтируется одним текстом.
   */
  const needsBodyMeasure = measuredBody == null;
  const needsTimeMeasure = measuredTimeWidthPx == null;

  const renderInlineContent = () => {
    if (layoutLines.length <= 1) {
      return (
        <View style={styles.inlineSingleRow}>
          <Text style={[bodyStyle, styles.inlineShrinkText]}>{body}</Text>
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
            metaLayout != null ? { width: metaLayout.inlineBlockWidthPx } : null,
          ]}
        >
          <Text style={[bodyStyle, styles.inlineShrinkText]}>{lastLine}</Text>
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
    <View
      style={[
        styles.inlineWrap,
        maxBubbleInnerWidthPx > 0 ? { maxWidth: maxBubbleInnerWidthPx } : null,
      ]}
    >
      {needsBodyMeasure ? (
        <View style={[styles.measureSlot, { width: maxBubbleInnerWidthPx }]} pointerEvents="none">
          <Text key={maxBubbleInnerWidthPx} style={bodyStyle} onTextLayout={onBodyTextLayout}>
            {body}
          </Text>
        </View>
      ) : null}
      {needsTimeMeasure ? (
        <View style={styles.measureSlot} pointerEvents="none">
          <Text style={timeStyle} onTextLayout={onTimeTextLayout}>
            {timeLabel}
          </Text>
        </View>
      ) : null}

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
  },
  measureSlot: {
    position: "absolute",
    left: 0,
    top: 0,
    opacity: 0,
    zIndex: -1,
  },
  inlineSingleRow: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  inlineLastRow: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  /** Текст уступает мете: пока замер не сошёлся, строка переносится, а не вылезает из пузыря. */
  inlineShrinkText: {
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
    gap: 2,
  },
  meta: {
    alignSelf: "flex-end",
  },
});
