import { apiGetPostComments, type PostCommentDto } from "@/lib/socialApi";

const cache = new Map<string, PostCommentDto[]>();
const inflight = new Map<string, Promise<PostCommentDto[]>>();

export function getCachedPostComments(postUuid: string): PostCommentDto[] | null {
  const hit = cache.get(postUuid);
  return hit ? cloneComments(hit) : null;
}

export function setCachedPostComments(postUuid: string, items: PostCommentDto[]): void {
  cache.set(postUuid, cloneComments(items));
}

export function patchCachedCommentReplies(
  postUuid: string,
  commentUuid: string,
  replies: PostCommentDto[],
): PostCommentDto[] | null {
  const current = cache.get(postUuid);
  if (!current) return null;
  const next = patchCommentRepliesInTree(current, commentUuid, replies);
  cache.set(postUuid, cloneComments(next));
  return cloneComments(next);
}

export function patchCommentRepliesInTree(
  items: PostCommentDto[],
  commentUuid: string,
  replies: PostCommentDto[],
): PostCommentDto[] {
  return items.map((c) => {
    if (c.commentUuid === commentUuid) {
      return {
        ...c,
        replies,
        repliesCount: Math.max(c.repliesCount, replies.length),
      };
    }
    if (c.replies?.length) {
      return { ...c, replies: patchCommentRepliesInTree(c.replies, commentUuid, replies) };
    }
    return c;
  });
}

/** Предзагрузка корневых комментариев (без вложенных ответов) для постов ленты. */
export function preloadPostComments(postUuids: string[]): void {
  const unique = [...new Set(postUuids.map((id) => id.trim()).filter(Boolean))];
  for (const postUuid of unique) {
    if (cache.has(postUuid) || inflight.has(postUuid)) continue;
    const task = apiGetPostComments(postUuid, { includeReplies: false })
      .then((items) => {
        cache.set(postUuid, cloneComments(items));
        return items;
      })
      .finally(() => {
        inflight.delete(postUuid);
      });
    inflight.set(postUuid, task);
  }
}

/** Гарантирует наличие корневых комментариев в кэше (для открытой панели). */
export async function ensurePostCommentsPrefetched(postUuid: string): Promise<PostCommentDto[]> {
  const id = postUuid.trim();
  if (!id) return [];
  const cached = cache.get(id);
  if (cached) return cloneComments(cached);
  const pending = inflight.get(id);
  if (pending) return pending.then(cloneComments);
  const task = apiGetPostComments(id, { includeReplies: false }).then((items) => {
    cache.set(id, cloneComments(items));
    return items;
  });
  inflight.set(id, task);
  try {
    return await task;
  } finally {
    inflight.delete(id);
  }
}

function cloneComments(items: PostCommentDto[]): PostCommentDto[] {
  return items.map((c) => ({
    ...c,
    replies: c.replies?.length ? cloneComments(c.replies) : [],
  }));
}
