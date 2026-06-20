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
        <Stack.Screen name="compose" options={{ title: "Новый пост" }} />
        <Stack.Screen name="people" options={{ headerShown: false }} />
        <Stack.Screen name="profile/[username]" options={{ title: "Профиль" }} />
        <Stack.Screen name="communities/index" options={{ headerShown: false }} />
        <Stack.Screen name="communities/[slug]" options={{ title: "Сообщество" }} />
        <Stack.Screen name="settings/index" options={{ title: "Настройки" }} />
        <Stack.Screen name="upgrade-required" options={{ title: "Обновление" }} />
      </Stack>
    </FloraProviders>
  );
}
