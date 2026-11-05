import "@/lib/cryptoPolyfill";
import "@/lib/api";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Modal } from "react-native";
import { enableFreeze } from "react-native-screens";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountBlockedWall } from "@/components/AccountBlockedWall";
import { FloraProviders } from "@/providers/FloraProviders";
import { FloraThemeProvider, useFloraTheme } from "@/lib/FloraThemeProvider";
import { floraColors, floraNativeStackOptions } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";

export { ErrorBoundary } from "expo-router";

enableFreeze(true);

function RootContent() {
  const { themeId } = useFloraTheme();
  const accountBlocked = useSessionStore((s) => s.me?.accountBlocked === true);
  const statusBarStyle = themeId === "light" ? "dark" : "light";

  return (
    <>
      <StatusBar style={statusBarStyle} />
      <Stack screenOptions={{ ...floraNativeStackOptions }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="compose" options={{ headerShown: false }} />
        <Stack.Screen name="community-settings/[slug]" options={{ title: "Настройки сообщества" }} />
        <Stack.Screen name="people" options={{ headerShown: false }} />
        <Stack.Screen name="profile/[username]" options={{ headerShown: false }} />
        <Stack.Screen name="communities/index" options={{ headerShown: false }} />
        <Stack.Screen name="communities/[slug]" options={{ headerShown: false }} />
        <Stack.Screen name="upgrade-required" options={{ title: "Обновление" }} />
      </Stack>
      {accountBlocked ? (
        <Modal
          visible
          animationType="none"
          presentationStyle="fullScreen"
          statusBarTranslucent
          onRequestClose={() => undefined}
        >
          <SafeAreaProvider style={{ flex: 1, backgroundColor: floraColors.bg }}>
            <StatusBar style={statusBarStyle} />
            <AccountBlockedWall />
          </SafeAreaProvider>
        </Modal>
      ) : null}
    </>
  );
}

export default function RootLayout() {
  return (
    <FloraThemeProvider>
      <FloraProviders>
        <RootContent />
      </FloraProviders>
    </FloraThemeProvider>
  );
}
