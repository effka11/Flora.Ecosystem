import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { memo } from "react";
import { StyleSheet, View } from "react-native";

import { floraColors, floraSpacing } from "@/lib/theme";
import type { MessageDeliveryState } from "@/lib/messageDeliveryState";

type Props = {
  state: MessageDeliveryState;
  sentColor?: string;
  /** Меньший отступ, когда галочки идут сразу после inline-времени. */
  compactMargin?: boolean;
};

/** Без react-native-svg — работает в текущем dev build; размеры как messagesBubbleReceipt на Web. */
function ChatMessageReadReceiptInner({
  state,
  sentColor = "rgba(242, 244, 246, 0.78)",
  compactMargin = false,
}: Props) {
  const receiptStyle = [styles.receipt, compactMargin && styles.receiptCompactMargin];

  if (state === "sending") {
    return (
      <View style={receiptStyle} accessibilityLabel="Отправляется">
        <Ionicons name="time-outline" size={10} color={sentColor} />
      </View>
    );
  }

  if (state === "read") {
    return (
      <View style={[receiptStyle, styles.receiptRead]} accessibilityLabel="Прочитано">
        <Ionicons name="checkmark" size={11} color={floraColors.greenLight} />
        <Ionicons
          name="checkmark"
          size={11}
          color={floraColors.greenLight}
          style={styles.receiptReadSecond}
        />
      </View>
    );
  }

  return (
    <View style={receiptStyle} accessibilityLabel="Отправлено">
      <Ionicons name="checkmark" size={11} color={sentColor} />
    </View>
  );
}

export const ChatMessageReadReceipt = memo(ChatMessageReadReceiptInner);

const styles = liveGridStyles(() => StyleSheet.create({
  /** Fixed 18×10 slot so sending/sent/read never resize the bubble (parity web). */
  receipt: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    height: 10,
    marginLeft: floraSpacing.gridFine * 2,
    opacity: 0.82,
  },
  receiptCompactMargin: {
    marginLeft: 2,
  },
  receiptRead: {
    justifyContent: "flex-start",
    opacity: 1,
  },
  receiptReadSecond: {
    marginLeft: -8,
  },
}));
