import { Redirect } from "expo-router";

export default function UpdatesSettingsRedirect() {
  return <Redirect href={{ pathname: "/(tabs)/settings", params: { section: "updates" } }} />;
}
