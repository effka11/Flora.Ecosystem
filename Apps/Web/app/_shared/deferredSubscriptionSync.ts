export type PendingFollowOp = "follow" | "unfollow";
export type PendingCommunityOp = "join" | "leave";

/** Желаемое состояние относительно снимка с сервера при загрузке вкладки. */
export function reconcilePendingFollow(
  pending: Map<string, PendingFollowOp>,
  userId: string,
  wantFollowing: boolean,
  wasFollowingOnServer: boolean,
): void {
  if (wantFollowing === wasFollowingOnServer) pending.delete(userId);
  else pending.set(userId, wantFollowing ? "follow" : "unfollow");
}

export function reconcilePendingCommunityJoin(
  pending: Map<string, PendingCommunityOp>,
  communityId: string,
  wantMember: boolean,
  wasMemberOnServer: boolean,
): void {
  if (wantMember === wasMemberOnServer) pending.delete(communityId);
  else pending.set(communityId, wantMember ? "join" : "leave");
}

export function applyCountDelta(
  deltas: Record<string, number>,
  id: string,
  delta: number,
): Record<string, number> {
  if (delta === 0) return deltas;
  const next = { ...deltas };
  const value = (next[id] ?? 0) + delta;
  if (value === 0) delete next[id];
  else next[id] = value;
  return next;
}

export function withCountDelta(count: number, delta: number): number {
  return Math.max(0, count + delta);
}
