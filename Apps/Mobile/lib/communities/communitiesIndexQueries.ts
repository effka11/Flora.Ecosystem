import {
  apiGetCommunities,
  apiGetOwnedCommunities,
  apiGetRecommendedCommunities,
  apiListProfileCommunities,
} from "@flora/client-core/api";
import type { CommunityListItemDto } from "@flora/client-core/contracts";

/** Root Communities tab cache keys — not search. */
export const COMMUNITIES_QUERY_ROOT = "communities" as const;
export const COMMUNITIES_RECOMMENDED_SEGMENT = "recommended" as const;
export const COMMUNITIES_OWNED_SEGMENT = "owned" as const;
export const COMMUNITIES_SUBSCRIPTIONS_SEGMENT = "subscriptions" as const;

export const COMMUNITIES_RECOMMENDED_QUERY_KEY = [
  COMMUNITIES_QUERY_ROOT,
  COMMUNITIES_RECOMMENDED_SEGMENT,
] as const;

export const COMMUNITIES_OWNED_QUERY_KEY = [
  COMMUNITIES_QUERY_ROOT,
  COMMUNITIES_OWNED_SEGMENT,
] as const;

export function communitiesIndexUsername(username: string) {
  return username.replace(/^@+/, "");
}

export function communitiesSubscriptionsQueryKey(username: string) {
  return [
    COMMUNITIES_QUERY_ROOT,
    COMMUNITIES_SUBSCRIPTIONS_SEGMENT,
    communitiesIndexUsername(username),
  ] as const;
}

export async function fetchCommunitiesRecommendedQuery() {
  return apiGetRecommendedCommunities(30);
}

export async function fetchCommunitiesOwnedQuery() {
  return apiGetOwnedCommunities();
}

export async function fetchCommunitiesSubscriptionsQuery(
  username: string,
): Promise<CommunityListItemDto[]> {
  const stripped = communitiesIndexUsername(username);
  const [profileItems, publicList] = await Promise.all([
    apiListProfileCommunities(stripped),
    apiGetCommunities(),
  ]);
  const publicBySlug = new Map(publicList.map((item) => [item.slug, item]));
  return profileItems.map((item) => {
    const full = publicBySlug.get(item.slug);
    if (full) return { ...full, role: "Member" as const };
    return {
      communityId: item.slug,
      name: item.name,
      slug: item.slug,
      memberCount: 0,
      avatarUuid: null,
      role: "Member" as const,
    };
  });
}
