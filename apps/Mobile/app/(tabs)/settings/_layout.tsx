import { useFloraTheme } from "@/lib/FloraThemeProvider";
import { Stack } from "expo-router";
import { floraNativeStackOptions } from "@/lib/theme";

/** Nested section deep-links (`/settings/account` → Redirect) under the settings tab. */
export default function SettingsTabLayout() {
  useFloraTheme();
  return (
    <Stack
      screenOptions={{
        ...floraNativeStackOptions,
        headerShown: false,
        animation: "none",
      }}
    />
  );
}
