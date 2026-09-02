import type { FeedPage } from "@flora/client-core/contracts";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

type PostUuidRow = { postUuid: string };

function dropByPostUuid<T extends PostUuidRow>(items: T[], postUuid: string): T[] {
  return items.filter((item) => item.postUuid !== postUuid);
}

function isFeedInfiniteData(data: unknown): data is InfiniteData<FeedPage> {
  if (!data || typeof data !== "object" || !("pages" in data)) return false;
  const pages = (data as InfiniteData<FeedPage>).pages;
  if (!Array.isArray(pages)) return false;
  return pages.every((page) => page != null && typeof page === "object" && Array.isArray(page.items));
}

function dropFromFeedInfinite(
  data: InfiniteData<FeedPage>,
  postUuid: string,
): InfiniteData<FeedPage> {
  let changed = false;
  const pages = data.pages.map((page) => {
    const items = dropByPostUuid(page.items, postUuid);
    if (items.length === page.items.length) return page;
    changed = true;
    return { ...page, items };
  });
  return changed ? { ...data, pages } : data;
}

function dropFromPostUuidList(data: unknown, postUuid: string): unknown {
  if (!Array.isArray(data)) return data;
  const items = data as PostUuidRow[];
  const next = dropByPostUuid(items, postUuid);
  return next.length === items.length ? data : next;
}

/**
 * Убирает пост из кэшей ленты (infinite + search), стены профиля и стены сообщества.
 * Не трогает курсоры страниц — пустые страницы остаются, чтобы не сломать пагинацию.
 */
export function removePostFromSocialCaches(queryClient: QueryClient, postUuid: string): void {
  const id = postUuid.trim();
  if (!id) return;

  queryClient.setQueriesData({ queryKey: ["feed"] }, (old) => {
    if (!old) return old;
    if (Array.isArray(old)) return dropFromPostUuidList(old, id);
    if (isFeedInfiniteData(old)) return dropFromFeedInfinite(old, id);
    return old;
  });
  queryClient.setQueriesData({ queryKey: ["profile-posts"] }, (old) =>
    dropFromPostUuidList(old, id),
  );
  queryClient.setQueriesData({ queryKey: ["community-posts"] }, (old) =>
    dropFromPostUuidList(old, id),
  );
}
