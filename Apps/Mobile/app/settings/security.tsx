import { Redirect } from "expo-router";

export default function SecuritySettingsRedirect() {
  return <Redirect href={{ pathname: "/settings", params: { section: "security" } }} />;
}
