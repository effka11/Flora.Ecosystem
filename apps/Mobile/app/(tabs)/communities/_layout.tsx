import { Stack } from "expo-router";
import { useFloraTheme } from "@/lib/FloraThemeProvider";
import { floraNativeStackOptions } from "@/lib/theme";

export default function CommunitiesStackLayout() {
  useFloraTheme();
  return (
    <Stack screenOptions={{ ...floraNativeStackOptions, headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[slug]" />
    </Stack>
  );
}
