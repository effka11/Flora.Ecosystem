import { Redirect, useLocalSearchParams } from "expo-router";
import { composeScreenHref } from "@/lib/socialRoutes";

/** Legacy root route → compose внутри вкладки Feed (нижний бар остаётся). */
export default function ComposeRedirect() {
  const params = useLocalSearchParams<{ communityUuid?: string | string[] }>();
  const communityUuid = Array.isArray(params.communityUuid) ? params.communityUuid[0] : params.communityUuid;

  return <Redirect href={composeScreenHref(communityUuid)} />;
}
