import { memo } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";

import { ChatMessageBubbleTime } from "@/components/messages/ChatMessageBubbleTime";
import type { MessageDeliveryState } from "@/lib/messageDeliveryState";

type Props = {
  body: string;
  timeLabel: string;
  deliveryState: MessageDeliveryState | null;
  bodyStyle: StyleProp<TextStyle>;
  timeStyle: StyleProp<TextStyle>;
  receiptColor?: string;
};

/** Текст отдельно, дата+галочки отдельной строкой справа — как у voice/photo bubble. */
function ChatMessageBubbleTextBodyInner({
  body,
  timeLabel,
  deliveryState,
  bodyStyle,
  timeStyle,
  receiptColor,
}: Props) {
  return (
    <View style={styles.bodyBlock}>
      <Text style={bodyStyle}>{body}</Text>
      <ChatMessageBubbleTime
        timeLabel={timeLabel}
        deliveryState={deliveryState}
        timeStyle={timeStyle}
        receiptColor={receiptColor}
        containerStyle={styles.meta}
      />
    </View>
  );
}

export const ChatMessageBubbleTextBody = memo(ChatMessageBubbleTextBodyInner);

const styles = StyleSheet.create({
  bodyBlock: {
    maxWidth: "100%",
    gap: 2,
  },
  meta: {
    alignSelf: "flex-end",
  },
});
