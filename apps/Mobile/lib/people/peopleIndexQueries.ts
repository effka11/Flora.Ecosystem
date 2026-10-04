import {
  apiGetProfileFollowers,
  apiGetProfileFollowing,
  apiGetRecommendedUsers,
} from "@flora/client-core/api";

/** Root People tab cache keys — not search. */
export const PEOPLE_QUERY_ROOT = "people" as const;
export const PEOPLE_RECOMMENDED_SEGMENT = "recommended" as const;
export const PEOPLE_FOLLOWERS_SEGMENT = "followers" as const;
export const PEOPLE_FOLLOWING_SEGMENT = "following" as const;

export const PEOPLE_RECOMMENDED_QUERY_KEY = [
  PEOPLE_QUERY_ROOT,
  PEOPLE_RECOMMENDED_SEGMENT,
] as const;

export function peopleIndexUsername(username: string) {
  return username.replace(/^@+/, "");
}

export function peopleFollowersQueryKey(username: string) {
  return [PEOPLE_QUERY_ROOT, PEOPLE_FOLLOWERS_SEGMENT, peopleIndexUsername(username)] as const;
}

export function peopleFollowingQueryKey(username: string) {
  return [PEOPLE_QUERY_ROOT, PEOPLE_FOLLOWING_SEGMENT, peopleIndexUsername(username)] as const;
}

export async function fetchPeopleRecommendedQuery() {
  return apiGetRecommendedUsers(40);
}

export async function fetchPeopleFollowersQuery(username: string) {
  return apiGetProfileFollowers(peopleIndexUsername(username), { take: 50 });
}

export async function fetchPeopleFollowingQuery(username: string) {
  return apiGetProfileFollowing(peopleIndexUsername(username), { take: 50 });
}
