import { Redirect, useLocalSearchParams } from "expo-router";
import { decodeRouteParam, profileScreenHref } from "@/lib/socialRoutes";
import { useSessionStore } from "@/stores/sessionStore";

export default function ProfileRedirectScreen() {
  const { username: rawUsername } = useLocalSearchParams<{ username: string | string[] }>();
  const me = useSessionStore((s) => s.me);
  const username = Array.isArray(rawUsername) ? rawUsername[0] : rawUsername;
  if (!username) return <Redirect href="/(tabs)/profile" />;
  return <Redirect href={profileScreenHref(decodeRouteParam(username), me?.username)} />;
}
