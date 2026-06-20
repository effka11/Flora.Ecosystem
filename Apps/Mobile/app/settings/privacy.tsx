import { Redirect } from "expo-router";

export default function PrivacySettingsRedirect() {
  return <Redirect href={{ pathname: "/settings", params: { section: "privacy" } }} />;
}
