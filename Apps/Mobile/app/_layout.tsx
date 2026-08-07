import "@/lib/cryptoPolyfill";
import "@/lib/api";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { FloraProviders } from "@/providers/FloraProviders";
import { floraColors } from "@/lib/theme";

export { ErrorBoundary } from "expo-router";

export default function RootLayout() {
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
        <Stack.Screen name="settings/index" options={{ headerShown: false }} />
        <Stack.Screen name="settings/account" options={{ headerShown: false }} />
        <Stack.Screen name="settings/privacy" options={{ headerShown: false }} />
        <Stack.Screen name="settings/security" options={{ headerShown: false }} />
        <Stack.Screen name="settings/notifications" options={{ headerShown: false }} />
        <Stack.Screen name="settings/updates" options={{ headerShown: false }} />
        <Stack.Screen name="settings/feed" options={{ headerShown: false }} />
        <Stack.Screen name="settings/customization" options={{ headerShown: false }} />
        <Stack.Screen name="upgrade-required" options={{ title: "Обновление" }} />
      </Stack>
    </FloraProviders>
  );
}
