import { Redirect } from "expo-router";

export default function CustomizationSettingsRedirect() {
  return <Redirect href={{ pathname: "/(tabs)/settings", params: { section: "customization" } }} />;
}
