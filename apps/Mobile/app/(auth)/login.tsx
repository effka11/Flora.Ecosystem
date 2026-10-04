import { AuthFlow, type AuthFlowMode } from "@/components/auth/AuthFlow";
import { useLocalSearchParams } from "expo-router";

export default function LoginScreen() {
  const { panel } = useLocalSearchParams<{ panel?: string }>();
  const initialMode: AuthFlowMode = panel === "register" ? "register" : "login";
  return <AuthFlow initialMode={initialMode} />;
}
