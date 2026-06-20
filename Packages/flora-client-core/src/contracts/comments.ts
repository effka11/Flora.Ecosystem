import { asRecord, readNum, readStr, type ParseContext } from "./parse.js";

export type PostCommentDto = {
  commentUuid: string;
  authorUsername: string;
  authorDisplayName: string;
  authorAvatarUuid: string | null;
  authorUserUuid: string | null;
  content: string;
  createdAt: string;
  repliesCount: number;
  replies: PostCommentDto[];
};

export function parsePostComment(raw: unknown, ctx?: ParseContext): PostCommentDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const commentUuid = readStr(o, ["commentUuid", "CommentUuid"], fb);
  if (!commentUuid) return null;
  const repliesRaw = o.replies ?? o.Replies;
  const replies: PostCommentDto[] = [];
  if (Array.isArray(repliesRaw)) {
    for (const item of repliesRaw) {
      const parsed = parsePostComment(item, ctx);
      if (parsed) replies.push(parsed);
    }
  }
  return {
    commentUuid,
    authorUsername: readStr(o, ["authorUsername", "AuthorUsername"], fb),
    authorDisplayName: readStr(o, ["authorDisplayName", "AuthorDisplayName"], fb),
    authorAvatarUuid: readStr(o, ["authorAvatarUuid", "AuthorAvatarUuid"], fb) || null,
    authorUserUuid: readStr(o, ["authorUserUuid", "AuthorUserUuid"], fb) || null,
    content: readStr(o, ["content", "Content", "text", "Text"], fb),
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    repliesCount: readNum(o, ["repliesCount", "RepliesCount"], fb) ?? 0,
    replies,
  };
}

export function parsePostCommentsList(raw: unknown, ctx?: ParseContext): PostCommentDto[] {
  if (!Array.isArray(raw)) return [];
  const out: PostCommentDto[] = [];
  for (const item of raw) {
    const parsed = parsePostComment(item, ctx);
    if (parsed) out.push(parsed);
  }
  return out;
}
