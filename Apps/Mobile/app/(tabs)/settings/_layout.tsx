import { Stack } from "expo-router";

/** Nested section deep-links (`/settings/account` → Redirect) under the settings tab. */
export default function SettingsTabLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: "none" }} />;
}
