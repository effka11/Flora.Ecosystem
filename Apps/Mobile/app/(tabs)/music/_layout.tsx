import { Stack } from "expo-router";
import { floraNativeStackOptions } from "@/lib/theme";

export default function MusicStackLayout() {
  return (
    <Stack screenOptions={{ ...floraNativeStackOptions, headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="genre/[genreId]" />
      <Stack.Screen name="genre/[genreId]/[subgenreId]" />
      <Stack.Screen name="artist/[artistUuid]" />
      <Stack.Screen name="playlist/[playlistId]" />
    </Stack>
  );
}
