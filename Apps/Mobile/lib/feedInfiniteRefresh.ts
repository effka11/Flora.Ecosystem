/**
 * TQ v5 infinite `refetch()` walks every cached page sequentially. For pull-to-refresh
 * we want a single first-page fetch ΓÇö trim the cache to page 0 first (see TQ #5692).
 */
export type InfiniteQueryPagesData<TPage> = {
  pages: TPage[];
  pageParams: unknown[];
};

export function trimFeedInfiniteDataToFirstPage<TPage>(
  data: InfiniteQueryPagesData<TPage> | undefined,
): InfiniteQueryPagesData<TPage> | undefined {
  if (!data) return undefined;
  return {
    ...data,
    pages: data.pages.slice(0, 1),
    pageParams: data.pageParams.slice(0, 1),
  };
}
