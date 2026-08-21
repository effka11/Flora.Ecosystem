import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiGetCommunities,
  apiGetRecommendedCommunities,
  apiListProfileCommunities,
} from "@flora/client-core/api";
import {
  communitiesSubscriptionsQueryKey,
  fetchCommunitiesRecommendedQuery,
  fetchCommunitiesSubscriptionsQuery,
} from "./communitiesIndexQueries";

vi.mock("@flora/client-core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@flora/client-core/api")>();
  return {
    ...actual,
    apiListProfileCommunities: vi.fn(),
    apiGetCommunities: vi.fn(),
    apiGetRecommendedCommunities: vi.fn(),
  };
});

const listProfile = vi.mocked(apiListProfileCommunities);
const getCommunities = vi.mocked(apiGetCommunities);
const getRecommended = vi.mocked(apiGetRecommendedCommunities);

afterEach(() => {
  vi.clearAllMocks();
});

describe("communitiesSubscriptionsQueryKey", () => {
  it("shares cache keys for @alice and alice", () => {
    expect(communitiesSubscriptionsQueryKey("@alice")).toEqual(
      communitiesSubscriptionsQueryKey("alice"),
    );
  });
});

describe("fetchCommunitiesRecommendedQuery", () => {
  it("loads recommended with take 30", async () => {
    getRecommended.mockResolvedValue([]);
    await fetchCommunitiesRecommendedQuery();
    expect(getRecommended).toHaveBeenCalledWith(30);
  });
});

describe("fetchCommunitiesSubscriptionsQuery", () => {
  it("strips @ before listing profile communities", async () => {
    listProfile.mockResolvedValue([]);
    getCommunities.mockResolvedValue([]);
    await fetchCommunitiesSubscriptionsQuery("@alice");
    expect(listProfile).toHaveBeenCalledWith("alice");
  });

  it("merges public list fields and forces Member when the slug exists", async () => {
    listProfile.mockResolvedValue([{ name: "Flora", slug: "flora" }]);
    getCommunities.mockResolvedValue([
      {
        communityId: "uuid-flora",
        name: "Flora Club",
        slug: "flora",
        memberCount: 12,
        avatarUuid: "av-1",
        role: "Owner",
      },
    ]);
    await expect(fetchCommunitiesSubscriptionsQuery("alice")).resolves.toEqual([
      {
        communityId: "uuid-flora",
        name: "Flora Club",
        slug: "flora",
        memberCount: 12,
        avatarUuid: "av-1",
        role: "Member",
      },
    ]);
  });

  it("falls back to a Member stub when the slug is missing from the public list", async () => {
    listProfile.mockResolvedValue([{ name: "Hidden", slug: "hidden" }]);
    getCommunities.mockResolvedValue([]);
    await expect(fetchCommunitiesSubscriptionsQuery("alice")).resolves.toEqual([
      {
        communityId: "hidden",
        name: "Hidden",
        slug: "hidden",
        memberCount: 0,
        avatarUuid: null,
        role: "Member",
      },
    ]);
  });
});
