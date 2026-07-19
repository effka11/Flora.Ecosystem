import { apiGetFeed } from "@flora/client-core/api";
import type { FeedPage } from "@flora/client-core/contracts";
import NetInfo from "@react-native-community/netinfo";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import {
  canAttachToTail,
  shouldAttachStaged,
  shouldStartPrefetch,
} from "@/lib/feedPrefetchPolicy";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

type FeedKind = "recommendations" | "subscriptions";
type FeedInfiniteData = InfiniteData<FeedPage, unknown>;

type FeedQueryLike = {
  data: FeedInfiniteData | undefined;
  isFetching: boolean;
};

type Staging = {
  /** The request cursor (the tail's nextCursor when staging started). */
  cursor: string | null;
  inFlight: boolean;
  page: FeedPage | null;
};

const EMPTY_STAGING: Staging = { cursor: null, inFlight: false, page: null };

type UseStagedFeedPaginationArgs = {
  kind: FeedKind;
  feedQuery: FeedQueryLike;
  isActivePane: boolean;
  isSearching: boolean;
  take?: number;
};

/**
 * Owns feed pagination via staged pages so the observable infinite query is
 * never grown mid-gesture. On approach to the end (driven by the list's
 * viewport-relative `onEndReachedThreshold`) the next page is fetched into a
 * ref; it is attached to the react-query cache only once the list settles
 * (or as a safety-net when the very end is reached), and only if the query
 * tail is unchanged since the request.
 */
export function useStagedFeedPagination({
  kind,
  feedQuery,
  isActivePane,
  isSearching,
  take = 20,
}: UseStagedFeedPaginationArgs) {
  const queryClient = useQueryClient();
  const stagingRef = useRef<Staging>(EMPTY_STAGING);
  const onlineRef = useRef(true);

  const dataRef = useRef(feedQuery.data);
  dataRef.current = feedQuery.data;
  const isFetchingRef = useRef(feedQuery.isFetching);
  isFetchingRef.current = feedQuery.isFetching;
  const isActiveRef = useRef(isActivePane);
  isActiveRef.current = isActivePane;
  const isSearchingRef = useRef(isSearching);
  isSearchingRef.current = isSearching;

  useEffect(() => {
    const sub = NetInfo.addEventListener((state) => {
      // Unknown (`null`) is treated as online/metered, per policy.
      onlineRef.current = state.isConnected !== false;
    });
    return () => sub();
  }, []);

  const tailNextCursor = useCallback((): string | undefined => {
    const pages = dataRef.current?.pages;
    const last = pages?.[pages.length - 1];
    return last?.nextCursor ?? undefined;
  }, []);

  const attachStaged = useCallback(() => {
    const staged = stagingRef.current;
    if (!staged.page || !staged.cursor) return;
    const requestCursor = staged.cursor;
    const stagedPage = staged.page;
    queryClient.setQueryData<FeedInfiniteData>(["feed", kind], (old) => {
      if (!old) return old;
      const last = old.pages[old.pages.length - 1];
      const tailNext = last?.nextCursor ?? undefined;
      if (!canAttachToTail(tailNext, requestCursor)) return old;
      return {
        pages: [...old.pages, stagedPage],
        pageParams: [...old.pageParams, requestCursor],
      };
    });
    stagingRef.current = EMPTY_STAGING;
  }, [kind, queryClient]);

  const attachIfReady = useCallback(
    (force: boolean) => {
      if (
        shouldAttachStaged({
          hasStagedPage: stagingRef.current.page !== null,
          settled: isScrollSettled(),
          force,
        })
      ) {
        attachStaged();
      }
    },
    [attachStaged],
  );

  const startPrefetch = useCallback(() => {
    const staged = stagingRef.current;
    const tail = tailNextCursor();
    const gateOpen = shouldStartPrefetch({
      isActivePane: isActiveRef.current,
      isSearching: isSearchingRef.current,
      hasNextPage: Boolean(tail),
      isFetching: isFetchingRef.current,
      isStaging: staged.inFlight,
      hasStagedForTail: staged.page !== null && staged.cursor === tail,
      networkAllowsPrefetch: onlineRef.current,
    });
    if (!gateOpen || !tail) return;

    const requestCursor = tail;
    stagingRef.current = { cursor: requestCursor, inFlight: true, page: null };
    apiGetFeed({ kind, cursor: requestCursor, take })
      .then((page) => {
        if (stagingRef.current.cursor !== requestCursor) return;
        stagingRef.current = { cursor: requestCursor, inFlight: false, page };
        attachIfReady(false);
      })
      .catch(() => {
        // Leave already-displayed pages untouched; allow a later approach to retry.
        if (stagingRef.current.cursor === requestCursor) {
          stagingRef.current = EMPTY_STAGING;
        }
      });
  }, [attachIfReady, kind, tailNextCursor, take]);

  const onApproachingEnd = useCallback(() => {
    // Safety-net: at the very end, attach any ready page immediately.
    attachIfReady(true);
    startPrefetch();
  }, [attachIfReady, startPrefetch]);

  useEffect(() => {
    return subscribeScrollSettled((settled) => {
      if (settled) attachIfReady(false);
    });
  }, [attachIfReady]);

  // A refresh replaces the tail; drop any staged page tied to the old tail.
  const generatedAt = feedQuery.data?.pages[0]?.generatedAt ?? null;
  useEffect(() => {
    stagingRef.current = EMPTY_STAGING;
  }, [generatedAt, kind]);

  return { onApproachingEnd };
}
