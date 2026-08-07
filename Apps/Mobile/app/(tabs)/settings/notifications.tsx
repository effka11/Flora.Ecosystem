import { Redirect } from "expo-router";

export default function NotificationsSettingsRedirect() {
  return <Redirect href={{ pathname: "/(tabs)/settings", params: { section: "notifications" } }} />;
}
