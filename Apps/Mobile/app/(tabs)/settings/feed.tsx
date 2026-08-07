import { Redirect } from "expo-router";

export default function FeedSettingsRedirect() {
  return <Redirect href={{ pathname: "/(tabs)/settings", params: { section: "feed" } }} />;
}
