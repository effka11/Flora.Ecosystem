import { liveGridStyles } from "@/lib/liveGridStyles";
import { Modal, StyleSheet, Text, TouchableWithoutFeedback, useWindowDimensions, View } from "react-native";
import { floraColors, floraSpacing } from "@/lib/theme";

export type SettingsHintAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Props = {
  visible: boolean;
  message: string;
  onDismiss: () => void;
  /** Окно якоря из measureInWindow — снимать до открытия Modal. */
  anchor: SettingsHintAnchor | null;
};

const PANEL_MAX_WIDTH = 260;
const SIDE_GAP = () => floraSpacing.grid;

/** Мини-подсказка строго справа от якоря — символ не перекрывается. */
export function SettingsHintModal({ visible, message, onDismiss, anchor }: Props) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const position = (() => {
    if (!anchor || anchor.width <= 0) return null;
    const left = anchor.x + anchor.width + SIDE_GAP();
    const available = windowWidth - left - floraSpacing.grid;
    if (available < floraSpacing.grid * 6) return null;
    const maxWidth = Math.min(PANEL_MAX_WIDTH, available);
    const top = Math.min(
      Math.max(floraSpacing.grid, anchor.y),
      windowHeight - floraSpacing.grid * 4,
    );
    return { top, left, maxWidth };
  })();

  return (
    <Modal
      visible={visible && position != null}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onDismiss} accessible={false}>
        <View style={styles.modalRoot}>
          {position ? (
            <TouchableWithoutFeedback>
              <View
                style={[
                  styles.panel,
                  {
                    top: position.top,
                    left: position.left,
                    maxWidth: position.maxWidth,
                  },
                ]}
                accessibilityViewIsModal
              >
                <Text style={styles.message}>{message}</Text>
              </View>
            </TouchableWithoutFeedback>
          ) : null}
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  modalRoot: {
    flex: 1,
    backgroundColor: "transparent",
  },
  panel: {
    position: "absolute",
    borderRadius: 12,
    backgroundColor: floraColors.bg,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.06)",
    paddingHorizontal: floraSpacing.gridFine * 2,
    paddingVertical: floraSpacing.gridFine * 1.5,
    // Тень только вниз/вправо — не заезжает на символ слева.
    shadowColor: "#000",
    shadowOffset: { width: 4, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  message: {
    color: "rgba(250, 250, 250, 0.9)",
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
    lineHeight: 20,
  },
}));
