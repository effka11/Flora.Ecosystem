import { Redirect } from "expo-router";
import { useSessionStore } from "@/stores/sessionStore";

export default function Index() {
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated);
  const pendingProfileSetup = useSessionStore((s) => s.pendingProfileSetup);

  if (!isAuthenticated) return <Redirect href="/(auth)/login" />;
  if (pendingProfileSetup) return <Redirect href="/(auth)/complete-profile" />;
  return <Redirect href="/(tabs)/feed" />;
}
