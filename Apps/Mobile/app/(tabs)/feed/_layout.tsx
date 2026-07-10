import { Stack } from "expo-router";
import { floraNativeStackOptions } from "@/lib/theme";

export default function FeedStackLayout() {
  return (
    <Stack screenOptions={{ ...floraNativeStackOptions, headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="compose" />
    </Stack>
  );
}
