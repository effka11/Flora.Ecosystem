import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, View } from "react-native";
import { ONLINE_STATUS_REF_AVATAR } from "@/components/messages/OnlineStatusDot";
import { floraColors } from "@/lib/theme";

/** Чуть крупнее online-dot, чтобы галочка читалась. */
const MARK_SIZE_AT_REF = 18;
const MARK_BORDER_AT_REF = 2;

type Props = {
  selected: boolean;
  avatarDiameter?: number;
};

/**
 * Галочка на SE аватара (место online-status) — только для выбранной строки.
 */
export function ConversationListSelectionMark({
  selected,
  avatarDiameter = ONLINE_STATUS_REF_AVATAR,
}: Props) {
  if (!selected) return null;

  const scale = avatarDiameter / ONLINE_STATUS_REF_AVATAR;
  const size = MARK_SIZE_AT_REF * scale;
  const borderWidth = MARK_BORDER_AT_REF * scale;
  const edgeInset = (avatarDiameter / 2) * (1 - Math.SQRT1_2);
  const offset = edgeInset - size / 2;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.mark,
        {
          right: offset,
          bottom: offset,
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth,
        },
      ]}
    >
      <Ionicons name="checkmark" size={Math.round(12 * scale)} color="#10200e" />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: floraColors.greenLight,
    borderColor: floraColors.bg,
  },
});
