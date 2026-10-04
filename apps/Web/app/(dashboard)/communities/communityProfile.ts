import type { CommunityProfileDto, OwnedCommunityDto, ProfileCommunityDto } from "@/lib/socialApi";
import type { CommunityRecord, CommunityTab } from "./communitiesSeed";

const COMMUNITY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCommunityUuid(value: string): boolean {
  return COMMUNITY_UUID_RE.test(value.trim());
}

export function communityListItemToRecord(
  item: Pick<OwnedCommunityDto, "communityId" | "name" | "slug" | "memberCount" | "avatarUuid">,
  tab: CommunityTab,
): CommunityRecord {
  return {
    id: item.communityId,
    slug: item.slug,
    name: item.name,
    members: item.memberCount,
    tab,
    description: "",
    posts: [],
    avatarUuid: item.avatarUuid ?? null,
  };
}

export function communityProfileToRecord(dto: CommunityProfileDto): CommunityRecord {
  return communityListItemToRecord(dto, "owned");
}

export function profileCommunityToRecord(
  item: ProfileCommunityDto,
  publicBySlug: ReadonlyMap<string, OwnedCommunityDto>,
  tab: CommunityTab = "subscriptions",
): CommunityRecord {
  const full = publicBySlug.get(item.slug);
  if (full) return communityListItemToRecord(full, tab);
  return {
    id: item.slug,
    slug: item.slug,
    name: item.name,
    members: 0,
    tab,
    description: "",
    posts: [],
  };
}
