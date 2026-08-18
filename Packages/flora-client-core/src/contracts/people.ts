import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type PeopleUserDto = {
  username: string;
  displayName: string;
  avatarUuid: string | null;
  followerCount: number;
  isFollowing: boolean;
  accountBlocked?: boolean;
  userUuid?: string;
  isOnline?: boolean;
  lastSeenAt?: string | null;
};

function parsePeopleUser(raw: unknown, ctx?: ParseContext, fallbackFollowing = false): PeopleUserDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const username = readStr(o, ["username", "Username"], fb).replace(/^@+/, "");
  if (!username) return null;
  const displayName = readStr(o, ["displayName", "DisplayName"], fb) || username;
  const avatarUuid = readStr(o, ["avatarUuid", "AvatarUuid"], fb) || null;
  const followerCount = readNum(o, ["followerCount", "FollowerCount", "followersCount", "FollowersCount"], fb) ?? 0;
  const userUuid = readStr(o, ["userUuid", "UserUuid"], fb);
  const lastSeenAt = readStr(o, ["lastSeenAt", "LastSeenAt"], fb) || null;
  return {
    username,
    displayName,
    avatarUuid,
    followerCount,
    isFollowing: readBool(o, ["isFollowing", "IsFollowing"], fb) || fallbackFollowing,
    accountBlocked: readBool(o, ["accountBlocked", "AccountBlocked"], fb),
    isOnline: readBool(o, ["isOnline", "IsOnline"], fb),
    lastSeenAt,
    ...(userUuid ? { userUuid } : {}),
  };
}

export function parsePeopleUsersList(raw: unknown, ctx?: ParseContext, fallbackFollowing = false): PeopleUserDto[] {
  const itemsRaw = Array.isArray(raw)
    ? raw
    : asRecord(raw)?.items ?? asRecord(raw)?.Items;
  if (!Array.isArray(itemsRaw)) return [];
  const out: PeopleUserDto[] = [];
  for (const item of itemsRaw) {
    const parsed = parsePeopleUser(item, ctx, fallbackFollowing);
    if (parsed) out.push(parsed);
  }
  return out;
}
