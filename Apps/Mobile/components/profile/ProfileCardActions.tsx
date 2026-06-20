import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { floraColors, floraSpacing } from "@/lib/theme";

const ACTION_BTN_HEIGHT = floraSpacing.grid * 2 + floraSpacing.gridFine * 2;
const FOLLOW_ICON_SIZE = 18;

type ProfileCardActionsProps =
  | {
      variant: "own";
      onEditProfilePress: () => void;
    }
  | {
      variant: "other";
      onWritePress?: () => void;
      isFollowing?: boolean;
      followBusy?: boolean;
      onToggleFollow?: () => void;
    };

export function ProfileCardActions(props: ProfileCardActionsProps) {
  if (props.variant === "own") {
    return (
      <View style={styles.row}>
        <Pressable
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          onPress={props.onEditProfilePress}
          accessibilityRole="button"
          accessibilityLabel="Редактировать профиль"
        >
          <Text style={styles.btnText}>Редактировать профиль</Text>
        </Pressable>
      </View>
    );
  }

  const { onWritePress, isFollowing = false, followBusy = false, onToggleFollow } = props;
  const showWrite = !!onWritePress;
  const showFollowAsText = !showWrite && !!onToggleFollow;
  const showFollowAsIcon = showWrite && !!onToggleFollow;

  if (!showWrite && !showFollowAsText && !showFollowAsIcon) return null;

  return (
    <View style={styles.row}>
      {showWrite ? (
        <Pressable
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          onPress={onWritePress}
          accessibilityRole="button"
          accessibilityLabel="Написать сообщение"
        >
          <Text style={styles.btnText}>Написать</Text>
        </Pressable>
      ) : null}
      {showFollowAsText ? (
        <Pressable
          style={({ pressed }) => [
            styles.btn,
            pressed && styles.btnPressed,
            followBusy && styles.btnBusy,
          ]}
          disabled={followBusy}
          onPress={onToggleFollow}
          accessibilityRole="button"
          accessibilityLabel={isFollowing ? "Отписаться" : "Подписаться"}
        >
          <Text style={styles.btnText}>{isFollowing ? "Отписаться" : "Подписаться"}</Text>
        </Pressable>
      ) : null}
      {showFollowAsIcon ? (
        <Pressable
          style={({ pressed }) => [
            styles.iconBtn,
            pressed && styles.iconBtnPressed,
            followBusy && styles.btnBusy,
          ]}
          disabled={followBusy}
          onPress={onToggleFollow}
          accessibilityRole="button"
          accessibilityLabel={isFollowing ? "Отписаться" : "Подписаться"}
        >
          <Ionicons
            name={isFollowing ? "person-remove-outline" : "person-add-outline"}
            size={FOLLOW_ICON_SIZE}
            color={floraColors.greenLight}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingLeft: floraSpacing.gridFine * 2,
    marginTop: floraSpacing.grid,
  },
  btn: {
    minHeight: ACTION_BTN_HEIGHT,
    paddingHorizontal: floraSpacing.gridFine * 4,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.4)",
    borderRadius: floraSpacing.gridFine * 2,
    backgroundColor: "transparent",
  },
  btnPressed: {
    backgroundColor: "rgba(164, 209, 138, 0.1)",
  },
  btnBusy: {
    opacity: 0.6,
  },
  btnText: {
    color: floraColors.greenLight,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  iconBtn: {
    width: ACTION_BTN_HEIGHT,
    height: ACTION_BTN_HEIGHT,
    borderRadius: ACTION_BTN_HEIGHT / 2,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.4)",
    backgroundColor: "rgba(164, 209, 138, 0.08)",
  },
  iconBtnPressed: {
    backgroundColor: "rgba(164, 209, 138, 0.16)",
  },
});
