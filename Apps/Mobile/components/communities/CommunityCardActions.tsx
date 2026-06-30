import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CommunityRole } from "@flora/client-core/contracts";
import { floraColors, floraSpacing } from "@/lib/theme";

const ACTION_BTN_HEIGHT = floraSpacing.grid * 2 + floraSpacing.gridFine * 2;

type CommunityCardActionsProps = {
  role?: CommunityRole | null;
  membershipBusy?: boolean;
  membershipError?: string | null;
  onComposePress?: () => void;
  onSettingsPress?: () => void;
  onSubscribePress?: () => void;
  onUnsubscribePress?: () => void;
};

export function CommunityCardActions({
  role,
  membershipBusy = false,
  membershipError,
  onComposePress,
  onSettingsPress,
  onSubscribePress,
  onUnsubscribePress,
}: CommunityCardActionsProps) {
  const isOwner = role === "Owner";
  const isMember = role === "Member";

  if (isOwner) {
    return (
      <View style={styles.wrap}>
        {membershipError ? <Text style={styles.error}>{membershipError}</Text> : null}
        <View style={styles.row}>
          {onComposePress ? (
            <Pressable
              style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
              onPress={onComposePress}
              accessibilityRole="button"
              accessibilityLabel="Сделать пост"
            >
              <Text style={styles.btnText}>Сделать пост</Text>
            </Pressable>
          ) : null}
          {onSettingsPress ? (
            <Pressable
              style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
              onPress={onSettingsPress}
              accessibilityRole="button"
              accessibilityLabel="Настройки сообщества"
            >
              <Text style={styles.btnText}>Настройки</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  if (isMember) {
    if (!onUnsubscribePress) return null;
    return (
      <View style={styles.wrap}>
        {membershipError ? <Text style={styles.error}>{membershipError}</Text> : null}
        <View style={styles.row}>
          <Pressable
            style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, membershipBusy && styles.btnBusy]}
            disabled={membershipBusy}
            onPress={onUnsubscribePress}
            accessibilityRole="button"
            accessibilityLabel="Отписаться"
          >
            <Text style={styles.btnText}>{membershipBusy ? "Отписка…" : "Отписаться"}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (!onSubscribePress) return null;

  return (
    <View style={styles.wrap}>
      {membershipError ? <Text style={styles.error}>{membershipError}</Text> : null}
      <View style={styles.row}>
        <Pressable
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, membershipBusy && styles.btnBusy]}
          disabled={membershipBusy}
          onPress={onSubscribePress}
          accessibilityRole="button"
          accessibilityLabel="Подписаться"
        >
          <Text style={styles.btnText}>{membershipBusy ? "Подписка…" : "Подписаться"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: floraSpacing.gridFine,
  },
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
  error: {
    color: floraColors.error,
    paddingLeft: floraSpacing.gridFine * 2,
    marginTop: floraSpacing.gridFine,
    fontSize: 13,
    fontWeight: "300",
  },
});
