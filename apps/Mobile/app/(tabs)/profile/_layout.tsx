import { Stack } from "expo-router";
import { floraNativeStackOptions } from "@/lib/theme";

export default function ProfileStackLayout() {
  return (
    <Stack screenOptions={{ ...floraNativeStackOptions, headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[username]" />
    </Stack>
  );
}
