import { memo, type ReactNode } from "react";
import { View, StyleSheet } from "react-native";

type Props = {
  clientMessageKey: string;
  /**
   * Peer-group: later (newer) siblings paint on top. Raise this host while its
   * below-docked menu is open so the panel is not covered.
   */
  menuOpen?: boolean;
  children: ReactNode;
};

/**
 * Раньше здесь был отдельный translateY пузыря — он расходился с подъёмом ленты.
 * Подъём теперь общий (`playChatListInsertLift` на обёртке FlashList); host —
 * прозрачная обёртка под стабильный clientMessageKey / будущие хуки.
 */
function ChatMessageBirthHostInner({ menuOpen = false, children }: Props) {
  return (
    <View
      collapsable={false}
      style={[styles.host, menuOpen ? styles.hostMenuOpen : null]}
    >
      {children}
    </View>
  );
}

export const ChatMessageBirthHost = memo(ChatMessageBirthHostInner);

const styles = StyleSheet.create({
  host: {
    width: "100%",
    overflow: "visible",
  },
  hostMenuOpen: {
    zIndex: 8,
    elevation: 8,
  },
});
