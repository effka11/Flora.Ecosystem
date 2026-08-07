import { Redirect } from "expo-router";

export default function SecuritySettingsRedirect() {
  return <Redirect href={{ pathname: "/(tabs)/settings", params: { section: "security" } }} />;
}
