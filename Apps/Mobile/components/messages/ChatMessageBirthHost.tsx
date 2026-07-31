import { memo, type ReactNode } from "react";
import { View, StyleSheet } from "react-native";

type Props = {
  clientMessageKey: string;
  children: ReactNode;
};

/**
 * Раньше здесь был отдельный translateY пузыря — он расходился с подъёмом ленты.
 * Подъём теперь общий (`playChatListInsertLift` на обёртке FlashList); host —
 * прозрачная обёртка под стабильный clientMessageKey / будущие хуки.
 */
function ChatMessageBirthHostInner({ children }: Props) {
  return <View style={styles.host}>{children}</View>;
}

export const ChatMessageBirthHost = memo(ChatMessageBirthHostInner);

const styles = StyleSheet.create({
  host: {
    width: "100%",
  },
});
