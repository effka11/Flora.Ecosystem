import { liveGridStyles } from "@/lib/liveGridStyles";
import { memo } from "react";
import { useFloraGrid } from "@/lib/FloraGridProvider";
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

import { ChatMessageReadReceipt } from "@/components/messages/ChatMessageReadReceipt";
import type { MessageDeliveryState } from "@/lib/messageDeliveryState";
import { floraMessages, sPx } from "@/lib/theme";

type Props = {
  timeLabel: string;
  deliveryState: MessageDeliveryState | null;
  timeStyle: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  receiptColor?: string;
};

function ChatMessageBubbleTimeInner({
  timeLabel,
  deliveryState,
  timeStyle,
  containerStyle,
  receiptColor,
}: Props) {
  useFloraGrid();
  return (
    <View style={[styles.row, containerStyle]}>
      <Text style={[styles.timeLabel, timeStyle, deliveryState ? styles.timeLabelWithReceipt : null]}>
        {timeLabel}
      </Text>
      {deliveryState ? (
        <View style={styles.receiptSlot}>
          <ChatMessageReadReceipt state={deliveryState} sentColor={receiptColor} />
        </View>
      ) : null}
    </View>
  );
}

export const ChatMessageBubbleTime = memo(ChatMessageBubbleTimeInner);

const styles = liveGridStyles(() => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: sPx(18),
  },
  timeLabel: {
    fontSize: floraMessages.bubbleTimeFontSize,
    lineHeight: sPx(18),
  },
  /** Оптическое выравнивание даты с галочками (Android font padding). */
  timeLabelWithReceipt: {
    transform: [{ translateY: 1 }],
  },
  receiptSlot: {
    width: sPx(18),
    height: sPx(18),
    justifyContent: "center",
    alignItems: "center",
  },
}));
