import { Redirect } from "expo-router";

export default function PrivacySettingsRedirect() {
  return <Redirect href={{ pathname: "/(tabs)/settings", params: { section: "privacy" } }} />;
}
