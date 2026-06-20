import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type CommunityRole = "Owner" | "Member";

export type CommunityListItemDto = {
  communityId: string;
  name: string;
  slug: string;
  memberCount: number;
  avatarUuid: string | null;
  isPrivate?: boolean;
  role?: CommunityRole | null;
};

export type ProfileCommunityDto = {
  name: string;
  slug: string;
};

export type CommunitySearchDto = CommunityListItemDto;

function parseCommunityRole(raw: unknown): CommunityRole | null {
  if (raw === "Owner" || raw === "owner") return "Owner";
  if (raw === "Member" || raw === "member") return "Member";
  return null;
}

export function parseCommunityListItem(raw: unknown, ctx?: ParseContext): CommunityListItemDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const communityId = readStr(o, ["communityId", "CommunityId", "community_id"], fb);
  const slug = readStr(o, ["slug", "Slug"], fb);
  if (!communityId || !slug) return null;
  const name = readStr(o, ["name", "Name"], fb) || slug;
  const avatarUuid = readStr(o, ["avatarUuid", "AvatarUuid", "avatar_uuid"], fb) || null;
  const roleRaw = readStr(o, ["role", "Role"], fb);
  const isPrivate = readBool(o, ["isPrivate", "IsPrivate"], fb);
  return {
    communityId,
    name,
    slug,
    memberCount: readNum(o, ["memberCount", "MemberCount"], fb) ?? 0,
    avatarUuid,
    ...(typeof isPrivate === "boolean" ? { isPrivate } : {}),
    ...(roleRaw ? { role: parseCommunityRole(roleRaw) } : {}),
  };
}

export function parseCommunityList(raw: unknown, ctx?: ParseContext): CommunityListItemDto[] {
  const itemsRaw = Array.isArray(raw)
    ? raw
    : asRecord(raw)?.items ?? asRecord(raw)?.Items;
  if (!Array.isArray(itemsRaw)) return [];
  const out: CommunityListItemDto[] = [];
  for (const item of itemsRaw) {
    const parsed = parseCommunityListItem(item, ctx);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseProfileCommunity(raw: unknown, ctx?: ParseContext): ProfileCommunityDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const slug = readStr(o, ["slug", "Slug"], fb);
  if (!slug) return null;
  return {
    slug,
    name: readStr(o, ["name", "Name"], fb) || slug,
  };
}

export function parseProfileCommunitiesList(raw: unknown, ctx?: ParseContext): ProfileCommunityDto[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileCommunityDto[] = [];
  for (const item of raw) {
    const parsed = parseProfileCommunity(item, ctx);
    if (parsed) out.push(parsed);
  }
  return out;
}
