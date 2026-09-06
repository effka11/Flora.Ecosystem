import { liveGridStyles } from "@/lib/liveGridStyles";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { accountBlockedWallBody } from "@/lib/accountBlockedWallCopy";
import { floraColors, floraSpacing } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";

/**
 * Replaces Social while `/me.accountBlocked` is true. Logout is the only product
 * action that remains available — the navigator stays mounted underneath so
 * expo-router and session teardown can still route to login.
 */
export function AccountBlockedWall() {
  const insets = useSafeAreaInsets();
  const until = useSessionStore((s) => s.me?.accountBlockedUntil);
  const logout = useSessionStore((s) => s.logout);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = accountBlockedWallBody(until);

  const handleLogout = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await logout(false);
      router.replace("/(auth)/login");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выйти из аккаунта.");
      setBusy(false);
    }
  };

  return (
    <View
      style={[
        styles.root,
        { paddingTop: Math.max(insets.top, floraSpacing.grid * 2), paddingBottom: Math.max(insets.bottom, floraSpacing.grid * 2) },
      ]}
      accessibilityViewIsModal
      accessibilityRole="alert"
    >
      <View style={styles.copy}>
        <Text style={styles.title}>Аккаунт заблокирован</Text>
        <Text style={styles.body}>{body}</Text>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Выйти из аккаунта"
        disabled={busy}
        onPress={() => void handleLogout()}
        style={({ pressed }) => [styles.logout, pressed && !busy && styles.logoutPressed, busy && styles.logoutDisabled]}
      >
        {busy ? (
          <ActivityIndicator color="#f6a8a8" />
        ) : (
          <Text style={styles.logoutLabel}>Выйти</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
    paddingHorizontal: floraSpacing.grid * 2,
    justifyContent: "center",
    gap: floraSpacing.grid * 2,
  },
  copy: {
    gap: floraSpacing.grid,
  },
  title: {
    color: floraColors.text,
    fontSize: 22,
    fontWeight: "300",
    letterSpacing: 0.54,
  },
  body: {
    color: floraColors.textMuted,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
  },
  error: {
    color: "#f6a8a8",
    fontSize: 12,
    fontWeight: "300",
    lineHeight: 17,
  },
  logout: {
    alignSelf: "stretch",
    minHeight: floraSpacing.grid * 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(246, 168, 168, 0.55)",
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: floraSpacing.grid * 2,
  },
  logoutPressed: {
    opacity: 0.72,
  },
  logoutDisabled: {
    opacity: 0.55,
  },
  logoutLabel: {
    color: "#f6a8a8",
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
}));
