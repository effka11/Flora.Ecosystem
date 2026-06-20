import { Redirect } from "expo-router";

export default function NotificationsSettingsRedirect() {
  return <Redirect href={{ pathname: "/settings", params: { section: "notifications" } }} />;
}
