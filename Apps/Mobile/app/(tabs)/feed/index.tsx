import { apiFeedHasNew, apiSearchFeed } from "@flora/client-core/api";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useFocusEffect } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Pressable as GesturePressable } from "react-native-gesture-handler";
import Reanimated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FLORA_TAB_STRIP_PAD_X } from "@/components/chrome/FloraTabChipStrip";
import { FloraTabLabel, floraTabChrome } from "@/components/chrome/FloraTabLabel";
import { TabPagerTrack } from "@/components/chrome/TabPager";
import { SyncPagerTabIndicator } from "@/components/chrome/tabIndicatorBridge";
import { FrcImageDiagnosticsOverlay } from "@/components/dev/FrcImageDiagnosticsOverlay";
import {
  FeedPostList,
  useFeedQuery,
  type FeedKind,
  type FeedPostListHandle,
} from "@/components/feed/FeedPostList";
import { SEARCH_SUGGESTION_TAGS } from "@/components/SearchSuggestionTags";
import { TabScreenHeader } from "@/components/TabScreenHeader";
import { useCollapsibleHeader } from "@/lib/useCollapsibleHeader";
import { useNetworkClass } from "@/lib/useNetworkClass";
import {
  clearFrcImageQueuePauseOwner,
  setFrcImageQueuePaused,
} from "@/lib/frcImage";
import {
  schedulePagerMediaWake,
  type PagerMediaWakeHandle,
} from "@/lib/feedPagerMediaWake";
import { PagerOverlayScroll } from "@/lib/pagerFlashListScroll";
import {
  clearScrollActivityOwner,
  setScrollActivity,
} from "@/lib/scrollActivity";
import { composeScreenHref } from "@/lib/socialRoutes";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";
import { bindChipStripBusy, usePagerBusyFlags } from "@/lib/usePagerBusyFlags";
import { useTabPager } from "@/lib/useTabPager";

/** chromeRow 45 + gap 5 + tabs 35 + border 1 */
const FEED_CHROME_BODY_HEIGHT = 45 + 5 + 35 + 1;

type TabLayout = { x: number; width: number };

function feedKindIndex(kind: FeedKind) {
  return kind === "recommendations" ? 0 : 1;
}

export default function FeedScreen() {
  const insets = useSafeAreaInsets();
  const network = useNetworkClass();
  const queryClient = useQueryClient();
  const pagerMediaPauseOwner = useRef(Symbol("feed-pager")).current;
  const feedPagerOwner = useRef(Symbol("feed-pager-scroll")).current;
  const mediaWakeRef = useRef<PagerMediaWakeHandle | null>(null);
  const recommendationsPaneRef = useRef<FeedPostListHandle>(null);
  const kindTargetRef = useRef<FeedKind>("recommendations");
  const [kind, setKind] = useState<FeedKind>("recommendations");
  /** Which pane may decode FRC-I — cleared on pager start, restored after interactions. */
  const [mediaKind, setMediaKind] = useState<FeedKind | null>("recommendations");
  const [tabLayouts, setTabLayouts] = useState<Record<FeedKind, TabLayout | null>>({
    recommendations: null,
    subscriptions: null,
  });
  const [search, setSearch] = useState("");
  const [searchTagId, setSearchTagId] = useState<string>(SEARCH_SUGGESTION_TAGS.feed[0].id);
  const holdSearchFocusRef = useRef<(() => void) | null>(null);
  const [searchDismissEpoch, setSearchDismissEpoch] = useState(0);
  const bumpSearchDismiss = useCallback(() => {
    setSearchDismissEpoch((n) => n + 1);
  }, []);
  const pagerGenRef = useRef(0);
  const pagerHeldRef = useRef(false);
  const applyPagerScrollBusy = useCallback(
    (busy: boolean) => {
      setScrollActivity(feedPagerOwner, "drag", busy);
    },
    [feedPagerOwner],
  );
  const { reportTouch, reportPager, reportStrip } = usePagerBusyFlags(applyPagerScrollBusy);
  const chipStripBusy = useMemo(
    () => bindChipStripBusy(reportTouch, reportStrip, bumpSearchDismiss),
    [bumpSearchDismiss, reportStrip, reportTouch],
  );
  const [searchChromeOpen, setSearchChromeOpen] = useState(false);
  const queryText = search.trim();
  const hasSearch = queryText.length > 0;
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const estimatedHeaderHeight = insets.top + floraSpacing.grid + FEED_CHROME_BODY_HEIGHT;
  const {
    headerHeightPx,
    onHeaderLayout,
    headerAnimatedStyle,
    renderScrollComponents,
    setActivePane,
    expandChrome,
  } = useCollapsibleHeader({
    estimatedHeight: estimatedHeaderHeight,
  });
  const expandRecommendationsChrome = useCallback(() => expandChrome(0), [expandChrome]);
  const expandSubscriptionsChrome = useCallback(() => expandChrome(1), [expandChrome]);

  const cancelMediaWake = useCallback(() => {
    mediaWakeRef.current?.cancel();
    mediaWakeRef.current = null;
  }, []);

  const scheduleMediaWake = useCallback(
    (next: FeedKind) => {
      cancelMediaWake();
      mediaWakeRef.current = schedulePagerMediaWake({
        run: () => {
          mediaWakeRef.current = null;
          setMediaKind(next);
          setFrcImageQueuePaused(pagerMediaPauseOwner, "drag", false);
        },
      });
    },
    [cancelMediaWake, pagerMediaPauseOwner],
  );

  const beginPagerMotion = useCallback(() => {
    cancelMediaWake();
    setMediaKind(null);
    setFrcImageQueuePaused(pagerMediaPauseOwner, "drag", true);
    bumpSearchDismiss();
  }, [bumpSearchDismiss, cancelMediaWake, pagerMediaPauseOwner]);

  const endPagerMotion = useCallback(() => {
    scheduleMediaWake(kindTargetRef.current);
  }, [scheduleMediaWake]);

  const commitPagerIndex = useCallback(
    (index: number) => {
      const next: FeedKind = index === 0 ? "recommendations" : "subscriptions";
      kindTargetRef.current = next;
      setActivePane(index);
      setKind((current) => (current === next ? current : next));
      scheduleMediaWake(next);
    },
    [scheduleMediaWake, setActivePane],
  );

  const {
    scrollX,
    pageWidth,
    tabProgress,
    pagerPan,
    onBodyLayout,
    settleToIndex,
    pagerTargetRef,
  } = useTabPager({
    pageCount: 2,
    enabled: !hasSearch && !searchChromeOpen,
    initialIndex: 0,
    onTouchBegin: () => {
      beginPagerMotion();
      reportTouch(true);
    },
    onTouchEnd: () => {
      reportTouch(false);
      if (!pagerHeldRef.current) endPagerMotion();
    },
    onPagerStart: () => {
      pagerHeldRef.current = true;
      beginPagerMotion();
      pagerGenRef.current = reportPager(true);
    },
    onMotionEnd: () => {
      pagerHeldRef.current = false;
      reportPager(false, pagerGenRef.current);
      endPagerMotion();
    },
    onCommitIndex: commitPagerIndex,
  });

  useEffect(
    () => () => {
      mediaWakeRef.current?.cancel();
      mediaWakeRef.current = null;
      clearFrcImageQueuePauseOwner(pagerMediaPauseOwner);
      clearScrollActivityOwner(feedPagerOwner);
    },
    [feedPagerOwner, pagerMediaPauseOwner],
  );

  const recordTabLayout = useCallback((tab: FeedKind, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const recommendationsFeedQuery = useFeedQuery("recommendations");
  const subscriptionsFeedQuery = useFeedQuery("subscriptions");
  const searchQuery = useQuery({
    queryKey: ["feed", "search", queryText],
    enabled: hasSearch,
    queryFn: () => apiSearchFeed(queryText, 40),
  });
  const refreshSearch = useCallback(async () => {
    await searchQuery.refetch();
  }, [searchQuery]);

  const syncFeedPane = useCallback(() => {
    if (hasSearch) {
      setActivePane(0);
      expandChrome(0);
    } else {
      setActivePane(feedKindIndex(kind));
    }
  }, [expandChrome, hasSearch, kind, setActivePane]);

  useEffect(() => {
    syncFeedPane();
  }, [syncFeedPane]);

  useFocusEffect(syncFeedPane);

  const recommendationsGeneratedAt = recommendationsFeedQuery.data?.pages[0]?.generatedAt ?? null;

  const hasNewQuery = useQuery({
    queryKey: ["feed-has-new", recommendationsGeneratedAt],
    enabled: recommendationsGeneratedAt != null,
    queryFn: () => apiFeedHasNew(recommendationsGeneratedAt!),
    refetchInterval: 30_000,
  });

  const switchKind = useCallback(
    (next: FeedKind) => {
      const index = feedKindIndex(next);
      if (index === pagerTargetRef.current) return;
      kindTargetRef.current = next;
      bumpSearchDismiss();
      settleToIndex(index);
    },
    [bumpSearchDismiss, pagerTargetRef, settleToIndex],
  );

  const refreshFeeds = useCallback(() => {
    void recommendationsPaneRef.current?.refreshToTop();
    void queryClient.invalidateQueries({ queryKey: ["feed", "subscriptions"] });
    void hasNewQuery.refetch();
  }, [hasNewQuery, queryClient]);

  const showNewPostsBanner = !hasSearch && kind === "recommendations" && hasNewQuery.data === true;

  return (
    <View style={styles.root}>
      <View
        style={[styles.feedBody, pageWidth > 0 ? { width: pageWidth } : null]}
        onLayout={onBodyLayout}
      >
        <View style={styles.pagerHost} pointerEvents={hasSearch ? "none" : "auto"}>
          <TabPagerTrack pageCount={2} pageWidth={pageWidth} pagerPan={pagerPan} scrollX={scrollX}>
            <FeedPostList
              ref={recommendationsPaneRef}
              kind="recommendations"
              feedQuery={recommendationsFeedQuery}
              isActivePane={!hasSearch && kind === "recommendations"}
              mediaEnabled={!hasSearch && mediaKind === "recommendations"}
              pageWidth={pageWidth}
              contentPaddingTop={headerHeightPx}
              contentPaddingBottom={listPaddingBottom}
              online={network === "online"}
              renderScrollComponent={renderScrollComponents[0]}
              onScrolledToTop={expandRecommendationsChrome}
              onScrollBeginDrag={bumpSearchDismiss}
            />
            <FeedPostList
              kind="subscriptions"
              feedQuery={subscriptionsFeedQuery}
              isActivePane={!hasSearch && kind === "subscriptions"}
              mediaEnabled={!hasSearch && mediaKind === "subscriptions"}
              pageWidth={pageWidth}
              contentPaddingTop={headerHeightPx}
              contentPaddingBottom={listPaddingBottom}
              online={network === "online"}
              renderScrollComponent={renderScrollComponents[1]}
              onScrolledToTop={expandSubscriptionsChrome}
              onScrollBeginDrag={bumpSearchDismiss}
            />
          </TabPagerTrack>
        </View>
        {hasSearch ? (
          <View style={styles.searchOverlay}>
            <FeedPostList
              kind="recommendations"
              feedQuery={recommendationsFeedQuery}
              isActivePane
              mediaEnabled
              listedPosts={searchQuery.data ?? []}
              listedLoading={searchQuery.isLoading}
              listedError={searchQuery.isError}
              onListedRefresh={refreshSearch}
              pageWidth={pageWidth}
              contentPaddingTop={headerHeightPx}
              contentPaddingBottom={listPaddingBottom}
              online={network === "online"}
              renderScrollComponent={PagerOverlayScroll}
              onScrolledToTop={expandRecommendationsChrome}
              onScrollBeginDrag={bumpSearchDismiss}
            />
          </View>
        ) : null}
      </View>

      <Reanimated.View style={[styles.topChrome, headerAnimatedStyle]}>
        <TabScreenHeader
          title="Лента"
          placeholder="Поиск в ленте"
          value={search}
          onChangeText={setSearch}
          dismissKey={`${kind}:${searchDismissEpoch}`}
          holdSearchFocusRef={holdSearchFocusRef}
          createAction={{
            accessibilityLabel: "Создать пост",
            onPress: () => router.push(composeScreenHref()),
          }}
          searchTags={SEARCH_SUGGESTION_TAGS.feed}
          searchTagId={searchTagId}
          onSearchTagIdChange={setSearchTagId}
          onSearchActiveChange={setSearchChromeOpen}
          onChipPanBegin={chipStripBusy.onChipPanBegin}
          onChipPanFinalize={chipStripBusy.onChipPanFinalize}
          onChipPanDecayEnd={chipStripBusy.onChipPanDecayEnd}
          onLayout={onHeaderLayout}
          idle={({ stripOffset }) => (
            <View style={styles.tabs}>
              <SyncPagerTabIndicator
                scrollX={scrollX}
                pageWidth={pageWidth}
                start={tabLayouts.recommendations}
                end={tabLayouts.subscriptions}
                insetX={FLORA_TAB_STRIP_PAD_X}
                stripOffset={stripOffset}
              />
              <GesturePressable
                accessibilityRole="tab"
                accessibilityState={{ selected: kind === "recommendations" }}
                style={floraTabChrome.tabButton}
                onLayout={(event) => recordTabLayout("recommendations", event)}
                onPress={() => switchKind("recommendations")}
              >
                <FloraTabLabel index={0} label="Рекомендации" progress={tabProgress} />
              </GesturePressable>
              <GesturePressable
                accessibilityRole="tab"
                accessibilityState={{ selected: kind === "subscriptions" }}
                style={floraTabChrome.tabButton}
                onLayout={(event) => recordTabLayout("subscriptions", event)}
                onPress={() => switchKind("subscriptions")}
              >
                <FloraTabLabel index={1} label="Подписки" progress={tabProgress} />
              </GesturePressable>
            </View>
          )}
        />

        {showNewPostsBanner ? (
          <Pressable
            style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
            onPress={refreshFeeds}
          >
            <Ionicons name="arrow-up-outline" size={14} color={floraColors.greenLight} />
            <Text style={styles.bannerText}>Новые посты — нажмите, чтобы обновить</Text>
          </Pressable>
        ) : null}
      </Reanimated.View>

      <View pointerEvents="none" style={[styles.statusBarFill, { height: insets.top }]} />

      <FrcImageDiagnosticsOverlay />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg },
  topChrome: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  statusBarFill: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    backgroundColor: floraColors.bg,
  },
  feedBody: {
    flex: 1,
    overflow: "hidden",
  },
  pagerHost: {
    flex: 1,
  },
  searchOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: floraColors.bg,
    zIndex: 1,
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
  },
  banner: {
    marginHorizontal: floraSpacing.grid,
    marginTop: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(164, 209, 138, 0.28)",
    backgroundColor: "rgba(164, 209, 138, 0.12)",
    paddingHorizontal: 14,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  bannerText: {
    color: floraColors.greenLight,
    textAlign: "center",
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  pressed: {
    opacity: 0.72,
  },
});
