import { Redirect } from "expo-router";

export default function CustomizationSettingsRedirect() {
  return <Redirect href={{ pathname: "/settings", params: { section: "customization" } }} />;
}
