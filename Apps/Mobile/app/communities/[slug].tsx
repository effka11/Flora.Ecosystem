import { Redirect, useLocalSearchParams } from "expo-router";
import { communityScreenHref, decodeRouteParam } from "@/lib/socialRoutes";

export default function CommunitySlugRedirectScreen() {
  const { slug: rawSlug } = useLocalSearchParams<{ slug: string | string[] }>();
  const slug = Array.isArray(rawSlug) ? rawSlug[0] : rawSlug;
  if (!slug) return <Redirect href="/(tabs)/communities" />;
  return <Redirect href={communityScreenHref(decodeRouteParam(slug))} />;
}
