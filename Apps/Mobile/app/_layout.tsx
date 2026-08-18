import "@/lib/cryptoPolyfill";
import "@/lib/api";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Modal } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountBlockedWall } from "@/components/AccountBlockedWall";
import { FloraProviders } from "@/providers/FloraProviders";
import { floraColors } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";

export { ErrorBoundary } from "expo-router";

export default function RootLayout() {
  const accountBlocked = useSessionStore((s) => s.me?.accountBlocked === true);

  return (
    <FloraProviders>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: floraColors.surface },
          headerTintColor: floraColors.text,
          contentStyle: { backgroundColor: floraColors.bg },
        }}
      >
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
            <StatusBar style="light" />
            <AccountBlockedWall />
          </SafeAreaProvider>
        </Modal>
      ) : null}
    </FloraProviders>
  );
}
