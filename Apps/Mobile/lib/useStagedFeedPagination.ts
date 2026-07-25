import { apiGetFeed } from "@flora/client-core/api";
import type { FeedPage } from "@flora/client-core/contracts";
import { postImageUrl } from "@flora/client-core/display";
import NetInfo from "@react-native-community/netinfo";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useWindowDimensions } from "react-native";
import { feedRowContentWidth, firstImageDisplayWidth } from "@/lib/feedImageGeometry";
import {
  canAttachToTail,
  shouldAttachStaged,
  shouldPrewarmStagedPage,
  shouldStartPrefetch,
} from "@/lib/feedPrefetchPolicy";
import { prefetchFrcImage } from "@/lib/frcImage";
import { FrcPrefetchBand } from "@/lib/frcMediaMode";
import { getRowsAhead } from "@/lib/mediaBandwidth";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";
import { selectStagedPagePrewarmTargets } from "@/lib/stagedPagePrewarm";

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
  const { width: windowWidth } = useWindowDimensions();

  // Warms the staged page's own first images before it ever joins the list,
  // so the row that eventually mounts finds its file already in cache. Read
  // at warm-up time (not captured) for the same reason as `useFrcMediaBand`:
  // a resize must not restart downloads already in flight.
  const prewarmWidthsRef = useRef<Map<string, number>>(new Map());
  const prewarmBandRef = useRef<FrcPrefetchBand | null>(null);
  if (prewarmBandRef.current === null) {
    prewarmBandRef.current = new FrcPrefetchBand((url) =>
      prefetchFrcImage(url, { displayWidth: prewarmWidthsRef.current.get(url) }),
    );
  }

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

  // Queues downloads for the staged page's own leading images — the same
  // gates that guard requesting the page at all (point E of the brief) also
  // guard warming it, and a page with the gate closed simply cancels
  // whatever the previous staged page had warming.
  const warmStagedPage = useCallback(
    (page: FeedPage) => {
      const gateOpen = shouldPrewarmStagedPage({
        isActivePane: isActiveRef.current,
        isSearching: isSearchingRef.current,
        networkAllowsPrefetch: onlineRef.current,
      });
      const targets = gateOpen
        ? selectStagedPagePrewarmTargets({
            posts: page.items,
            rowsAhead: getRowsAhead(),
            urlForImage: postImageUrl,
          })
        : [];

      const contentWidth = feedRowContentWidth(windowWidth);
      prewarmWidthsRef.current = new Map(
        targets.map((target) => [target.url, firstImageDisplayWidth(contentWidth, target.imageCount)]),
      );
      prewarmBandRef.current?.sync(targets.map((target) => target.url));
    },
    [windowWidth],
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
        warmStagedPage(page);
      })
      .catch(() => {
        // Leave already-displayed pages untouched; allow a later approach to retry.
        if (stagingRef.current.cursor === requestCursor) {
          stagingRef.current = EMPTY_STAGING;
        }
      });
  }, [attachIfReady, kind, tailNextCursor, take, warmStagedPage]);

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

  // A refresh replaces the tail; drop any staged page tied to the old tail,
  // and cancel whatever of its images were mid-download — none of them will
  // ever mount now. Attaching a staged page to the list is deliberately not
  // one of these triggers: its rows may not be mounted yet, and cancelling
  // here would drop a file that is already most of the way in.
  const generatedAt = feedQuery.data?.pages[0]?.generatedAt ?? null;
  useEffect(() => {
    stagingRef.current = EMPTY_STAGING;
    prewarmBandRef.current?.stop();
  }, [generatedAt, kind]);

  useEffect(() => {
    return () => prewarmBandRef.current?.stop();
  }, []);

  return { onApproachingEnd };
}
