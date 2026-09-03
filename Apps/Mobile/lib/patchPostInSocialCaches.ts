import type { FeedPage } from "@flora/client-core/contracts";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

type PostUuidRow = { postUuid: string };

export type SocialPostCachePatch = {
  text: string;
  imageUuids: string[];
  videoUuid: string | null;
  videoStatus: string | null;
};

function isFeedInfiniteData(data: unknown): data is InfiniteData<FeedPage> {
  if (!data || typeof data !== "object" || !("pages" in data)) return false;
  const pages = (data as InfiniteData<FeedPage>).pages;
  if (!Array.isArray(pages)) return false;
  return pages.every((page) => page != null && typeof page === "object" && Array.isArray(page.items));
}

function applyPatch<T extends PostUuidRow>(item: T, postUuid: string, patch: SocialPostCachePatch): T {
  if (item.postUuid !== postUuid) return item;
  const next: Record<string, unknown> = { ...item };
  if ("text" in item) next.text = patch.text;
  if ("content" in item) next.content = patch.text;
  if ("imageUuids" in item) next.imageUuids = patch.imageUuids;
  if ("videoUuid" in item) next.videoUuid = patch.videoUuid;
  if ("videoStatus" in item) next.videoStatus = patch.videoStatus;
  return next as T;
}

function patchFeedInfinite(
  data: InfiniteData<FeedPage>,
  postUuid: string,
  patch: SocialPostCachePatch,
): InfiniteData<FeedPage> {
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((item) => {
      const next = applyPatch(item, postUuid, patch);
      if (next !== item) pageChanged = true;
      return next;
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, items };
  });
  return changed ? { ...data, pages } : data;
}

function patchPostUuidList(data: unknown, postUuid: string, patch: SocialPostCachePatch): unknown {
  if (!Array.isArray(data)) return data;
  let changed = false;
  const items = (data as PostUuidRow[]).map((item) => {
    const next = applyPatch(item, postUuid, patch);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? items : data;
}

/** Обновляет текст и медиа поста в кэшах ленты, профиля и сообщества. */
export function patchPostInSocialCaches(
  queryClient: QueryClient,
  postUuid: string,
  patch: SocialPostCachePatch,
): void {
  const id = postUuid.trim();
  if (!id) return;

  queryClient.setQueriesData({ queryKey: ["feed"] }, (old) => {
    if (!old) return old;
    if (Array.isArray(old)) return patchPostUuidList(old, id, patch);
    if (isFeedInfiniteData(old)) return patchFeedInfinite(old, id, patch);
    return old;
  });
  queryClient.setQueriesData({ queryKey: ["profile-posts"] }, (old) =>
    patchPostUuidList(old, id, patch),
  );
  queryClient.setQueriesData({ queryKey: ["community-posts"] }, (old) =>
    patchPostUuidList(old, id, patch),
  );
}
