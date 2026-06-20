import { Redirect } from "expo-router";

export default function RegisterScreen() {
  return <Redirect href="/(auth)/login?panel=register" />;
}
