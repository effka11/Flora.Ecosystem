import type { FeedPostDto } from "@flora/client-core/contracts";

export function handlesEqual(a: string, b: string): boolean {
  return a.trim().replace(/^@+/, "").toLowerCase() === b.trim().replace(/^@+/, "").toLowerCase();
}

type FeedPostAuthor = Pick<FeedPostDto, "authorUserUuid" | "authorUsername">;

type SessionIdentity = {
  userUuid?: string | null;
  username?: string | null;
};

/** Автор личного или community-поста в ленте — по uuid, иначе по handle (как Web). */
export function isOwnFeedPost(
  post: FeedPostAuthor,
  me: SessionIdentity | null | undefined,
): boolean {
  if (!me) return false;
  const meUuid = me.userUuid?.trim();
  const authorUuid = post.authorUserUuid.trim();
  if (meUuid && authorUuid && meUuid.toLowerCase() === authorUuid.toLowerCase()) {
    return true;
  }
  const meHandle = me.username?.trim();
  if (!meHandle) return false;
  return handlesEqual(meHandle, post.authorUsername);
}
