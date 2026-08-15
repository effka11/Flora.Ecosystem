import { apiGetMusicLibrary, apiGetMusicPlaylists } from "@flora/client-core/api";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Pressable as GesturePressable } from "react-native-gesture-handler";
import {
  cancelAnimation,
  runOnUI,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraTabLabel, floraTabChrome } from "@/components/chrome/FloraTabLabel";
import { FLORA_TAB_STRIP_PAD_X } from "@/components/chrome/FloraTabChipStrip";
import { TabPagerTrack } from "@/components/chrome/TabPager";
import {
  BlendedSearchTabIndicator,
  SyncIndexTabIndicator,
  SyncPagerTabIndicator,
  TabIndicatorBridgeProvider,
} from "@/components/chrome/tabIndicatorBridge";
import {
  AddTrackSection,
  MusicSearchResults,
  MyMusicSection,
  RecommendationsSection,
} from "@/components/music/MusicSections";
import {
  MUSIC_UPLOAD_TABS,
  type MusicBrowseTab,
  type MusicUploadTab,
} from "@/components/music/MusicTabBar";
import { SEARCH_SUGGESTION_TAGS } from "@/components/SearchSuggestionTags";
import { TabScreenHeader } from "@/components/TabScreenHeader";
import { ENERGETIC_OPEN_EASING, ENERGETIC_OPEN_MS, settleEnergetic } from "@/lib/energeticSettle";
import { mapMusicTracksDto, mapPlaylistSummaryDto } from "@/lib/music/musicModels";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";
import { bindChipStripBusy, usePagerBusyFlags } from "@/lib/usePagerBusyFlags";
import { useTabPager } from "@/lib/useTabPager";

type TabLayout = { x: number; width: number };

function browseTabIndex(tab: MusicBrowseTab) {
  return tab === "recommendations" ? 0 : 1;
}

function uploadTabIndex(tab: MusicUploadTab) {
  return tab === "forSelf" ? 0 : 1;
}

type MusicPaneProps = {
  tab: MusicBrowseTab;
  pageWidth: number;
  tracks: ReturnType<typeof mapMusicTracksDto>;
  playlists: ReturnType<typeof mapPlaylistSummaryDto>[];
  refreshing: boolean;
  onRefresh: () => void;
  overScrollMode: "auto" | "never";
};

function MusicPane({
  tab,
  pageWidth,
  tracks,
  playlists,
  refreshing,
  onRefresh,
  overScrollMode,
}: MusicPaneProps) {
  return (
    <View style={[styles.page, { width: pageWidth }]}>
      {tab === "recommendations" ? (
        <RecommendationsSection overScrollMode={overScrollMode} />
      ) : (
        <MyMusicSection
          tracks={tracks}
          playlists={playlists}
          refreshing={refreshing}
          onRefresh={onRefresh}
          overScrollMode={overScrollMode}
        />
      )}
    </View>
  );
}

export default function MusicScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const uploadLineProgress = useSharedValue(0);
  const uploadTabProgress = useSharedValue(0);

  const [search, setSearch] = useState("");
  const [searchTagId, setSearchTagId] = useState<string>(SEARCH_SUGGESTION_TAGS.music[0].id);
  const holdSearchFocusRef = useRef<(() => void) | null>(null);
  const [searchDismissEpoch, setSearchDismissEpoch] = useState(0);
  const bumpSearchDismiss = useCallback(() => {
    setSearchDismissEpoch((n) => n + 1);
  }, []);
  const pagerGenRef = useRef(0);
  const { reportTouch, reportPager, reportStrip } = usePagerBusyFlags();
  const chipStripBusy = useMemo(
    () => bindChipStripBusy(reportTouch, reportStrip, bumpSearchDismiss),
    [bumpSearchDismiss, reportStrip, reportTouch],
  );
  const [searchChromeOpen, setSearchChromeOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<MusicBrowseTab>("recommendations");
  const [addTrackOpen, setAddTrackOpen] = useState(false);
  const [uploadTab, setUploadTab] = useState<MusicUploadTab>("forSelf");
  const [tabLayouts, setTabLayouts] = useState<Record<MusicBrowseTab, TabLayout | null>>({
    recommendations: null,
    myMusic: null,
  });
  const [uploadLayouts, setUploadLayouts] = useState<Record<MusicUploadTab, TabLayout | null>>({
    forSelf: null,
    forPlatform: null,
  });
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));

  const libraryQuery = useQuery({
    queryKey: ["music-library"],
    queryFn: async () => mapMusicTracksDto(await apiGetMusicLibrary()),
  });

  const playlistsQuery = useQuery({
    queryKey: ["music-playlists"],
    queryFn: async () => (await apiGetMusicPlaylists()).map(mapPlaylistSummaryDto),
  });

  const tracks = libraryQuery.data ?? [];
  const playlists = playlistsQuery.data ?? [];
  const hasSearch = search.trim().length > 0;
  const loading = libraryQuery.isLoading || playlistsQuery.isLoading;
  const refreshing = libraryQuery.isFetching || playlistsQuery.isFetching;

  const refreshMusic = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["music-library"] });
    void queryClient.invalidateQueries({ queryKey: ["music-playlists"] });
  }, [queryClient]);

  const recordTabLayout = useCallback((tab: MusicBrowseTab, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const recordUploadLayout = useCallback((tab: MusicUploadTab, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setUploadLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const commitPagerIndex = useCallback((index: number) => {
    const next: MusicBrowseTab = index === 0 ? "recommendations" : "myMusic";
    setActiveTab((current) => (current === next ? current : next));
  }, []);

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
    initialIndex: browseTabIndex(activeTab),
    onTouchBegin: () => {
      bumpSearchDismiss();
      reportTouch(true);
    },
    onTouchEnd: () => reportTouch(false),
    onPagerStart: () => {
      pagerGenRef.current = reportPager(true);
    },
    onMotionEnd: () => {
      reportPager(false, pagerGenRef.current);
    },
    onCommitIndex: commitPagerIndex,
  });

  const switchTab = useCallback(
    (next: MusicBrowseTab) => {
      const index = browseTabIndex(next);
      if (index === pagerTargetRef.current) return;
      bumpSearchDismiss();
      settleToIndex(index);
    },
    [bumpSearchDismiss, pagerTargetRef, settleToIndex],
  );

  const selectUploadTab = useCallback(
    (next: MusicUploadTab) => {
      if (next === uploadTab) return;
      setUploadTab(next);
      const index = uploadTabIndex(next);
      runOnUI((target: number) => {
        "worklet";
        cancelAnimation(uploadTabProgress);
        settleEnergetic(uploadTabProgress, target, 1, 1, 0, ENERGETIC_OPEN_MS, ENERGETIC_OPEN_EASING);
      })(index);
    },
    [uploadTab, uploadTabProgress],
  );

  const handleUploaded = () => {
    refreshMusic();
    setSearch("");
    setAddTrackOpen(false);
    switchTab("myMusic");
  };

  return (
    <View style={styles.root}>
      <TabScreenHeader
        title="Музыка"
        placeholder="Поиск по музыке"
        value={search}
        onChangeText={setSearch}
        dismissKey={`${activeTab}:${searchDismissEpoch}`}
        holdSearchFocusRef={holdSearchFocusRef}
        createAction={{
          accessibilityLabel: "Добавить трек",
          onPress: () => setAddTrackOpen(true),
        }}
        searchTags={SEARCH_SUGGESTION_TAGS.music}
        searchTagId={searchTagId}
        onSearchTagIdChange={setSearchTagId}
        onSearchActiveChange={setSearchChromeOpen}
        onChipPanBegin={chipStripBusy.onChipPanBegin}
        onChipPanFinalize={chipStripBusy.onChipPanFinalize}
        onChipPanDecayEnd={chipStripBusy.onChipPanDecayEnd}
        idle={({ stripOffset }) => (
          <View style={styles.tabs}>
            <SyncPagerTabIndicator
              scrollX={scrollX}
              pageWidth={pageWidth}
              start={tabLayouts.recommendations}
              end={tabLayouts.myMusic}
              insetX={FLORA_TAB_STRIP_PAD_X}
              stripOffset={stripOffset}
            />
            <GesturePressable
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === "recommendations" }}
              style={floraTabChrome.tabButton}
              onLayout={(event) => recordTabLayout("recommendations", event)}
              onPress={() => switchTab("recommendations")}
            >
              <FloraTabLabel index={0} label="Рекомендации" progress={tabProgress} />
            </GesturePressable>
            <GesturePressable
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === "myMusic" }}
              style={floraTabChrome.tabButton}
              onLayout={(event) => recordTabLayout("myMusic", event)}
              onPress={() => switchTab("myMusic")}
            >
              <FloraTabLabel index={1} label="Моя музыка" progress={tabProgress} />
            </GesturePressable>
          </View>
        )}
      />

      <View style={[styles.body, { paddingBottom: listPaddingBottom }]} onLayout={onBodyLayout}>
        <View style={styles.pagerHost} pointerEvents={hasSearch ? "none" : "auto"}>
          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={floraColors.greenLight} />
              <Text style={styles.emptyHint}>Загрузка музыки…</Text>
            </View>
          ) : (
            <TabPagerTrack pageCount={2} pageWidth={pageWidth} pagerPan={pagerPan} scrollX={scrollX}>
              <MusicPane
                tab="recommendations"
                pageWidth={pageWidth}
                tracks={tracks}
                playlists={playlists}
                refreshing={refreshing}
                onRefresh={refreshMusic}
                overScrollMode={hasSearch || activeTab !== "recommendations" ? "never" : "auto"}
              />
              <MusicPane
                tab="myMusic"
                pageWidth={pageWidth}
                tracks={tracks}
                playlists={playlists}
                refreshing={refreshing}
                onRefresh={refreshMusic}
                overScrollMode={hasSearch || activeTab !== "myMusic" ? "never" : "auto"}
              />
            </TabPagerTrack>
          )}
        </View>
        {hasSearch ? (
          <View style={styles.searchOverlay}>
            <MusicSearchResults query={search} onScrollBeginDrag={bumpSearchDismiss} />
          </View>
        ) : null}
      </View>

      <Modal
        visible={addTrackOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAddTrackOpen(false)}
      >
        <View style={[styles.modalRoot, { paddingTop: insets.top + floraSpacing.grid }]}>
          <View style={styles.modalHeader}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
              style={({ pressed }) => [styles.modalClose, pressed && styles.pressed]}
              onPress={() => setAddTrackOpen(false)}
            >
              <Ionicons name="close" size={24} color={floraColors.gray} />
            </Pressable>
            <Text style={styles.modalTitle}>Добавить трек</Text>
            <View style={styles.modalClose} />
          </View>
          <TabIndicatorBridgeProvider>
            <View style={styles.uploadTabs}>
              <View style={styles.tabs}>
                <SyncIndexTabIndicator
                  progress={uploadTabProgress}
                  layouts={[uploadLayouts.forSelf, uploadLayouts.forPlatform]}
                />
                {MUSIC_UPLOAD_TABS.map((tab, index) => (
                  <GesturePressable
                    key={tab.id}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: uploadTab === tab.id }}
                    style={floraTabChrome.tabButton}
                    onLayout={(event) => recordUploadLayout(tab.id, event)}
                    onPress={() => selectUploadTab(tab.id)}
                  >
                    <FloraTabLabel index={index} label={tab.label} progress={uploadTabProgress} />
                  </GesturePressable>
                ))}
                <BlendedSearchTabIndicator progress={uploadLineProgress} />
              </View>
            </View>
          </TabIndicatorBridgeProvider>
          <AddTrackSection uploadMode={uploadTab} onUploaded={handleUploaded} />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
  },
  body: {
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
  page: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: floraSpacing.grid,
  },
  emptyHint: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  pressed: {
    opacity: 0.72,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: floraSpacing.gridFine,
  },
  modalClose: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  modalTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 17,
    fontWeight: "300",
    letterSpacing: 0.51,
  },
  uploadTabs: {
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: floraSpacing.gridFine,
  },
});
