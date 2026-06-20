import { Redirect } from "expo-router";

export default function AccountSettingsRedirect() {
  return <Redirect href={{ pathname: "/settings", params: { section: "account" } }} />;
}
