import { apiGetMusicLibrary, apiGetMusicPlaylists } from "@flora/client-core/api";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AddTrackSection,
  MyMusicSection,
  RecommendationsSection,
  MusicSearchResults,
} from "@/components/music/MusicSections";
import {
  MUSIC_UPLOAD_TABS,
  MusicTabBar,
  type MusicBrowseTab,
  type MusicUploadTab,
} from "@/components/music/MusicTabBar";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import { mapMusicTracksDto, mapPlaylistSummaryDto } from "@/lib/music/musicModels";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";

type TabLayout = { x: number; width: number };

function browseTabIndex(tab: MusicBrowseTab) {
  return tab === "recommendations" ? 0 : 1;
}

type MusicPaneProps = {
  tab: MusicBrowseTab;
  pageWidth: number;
  tracks: ReturnType<typeof mapMusicTracksDto>;
  playlists: ReturnType<typeof mapPlaylistSummaryDto>[];
  refreshing: boolean;
  onRefresh: () => void;
};

function MusicPane({ tab, pageWidth, tracks, playlists, refreshing, onRefresh }: MusicPaneProps) {
  return (
    <View style={[styles.page, { width: pageWidth }]}>
      {tab === "recommendations" ? (
        <RecommendationsSection />
      ) : (
        <MyMusicSection
          tracks={tracks}
          playlists={playlists}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      )}
    </View>
  );
}

export default function MusicScreen() {
  const insets = useSafeAreaInsets();
  const { width: pageWidth } = useWindowDimensions();
  const queryClient = useQueryClient();
  const pagerRef = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(0)).current;

  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<MusicBrowseTab>("recommendations");
  const [addTrackOpen, setAddTrackOpen] = useState(false);
  const [uploadTab, setUploadTab] = useState<MusicUploadTab>("forSelf");
  const [tabLayouts, setTabLayouts] = useState<Record<MusicBrowseTab, TabLayout | null>>({
    recommendations: null,
    myMusic: null,
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

  const tabIndicatorStyle = useMemo(() => {
    const recommendations = tabLayouts.recommendations;
    const myMusic = tabLayouts.myMusic;
    if (!recommendations || !myMusic || pageWidth <= 0) return null;

    return {
      width: scrollX.interpolate({
        inputRange: [0, pageWidth],
        outputRange: [recommendations.width, myMusic.width],
        extrapolate: "clamp",
      }),
      transform: [
        {
          translateX: scrollX.interpolate({
            inputRange: [0, pageWidth],
            outputRange: [recommendations.x, myMusic.x],
            extrapolate: "clamp",
          }),
        },
      ],
    };
  }, [pageWidth, scrollX, tabLayouts.myMusic, tabLayouts.recommendations]);

  const tabLabelColors = useMemo(() => {
    if (pageWidth <= 0) return null;

    return {
      recommendations: scrollX.interpolate({
        inputRange: [0, pageWidth],
        outputRange: [floraColors.greenLight, floraColors.gray],
        extrapolate: "clamp",
      }),
      myMusic: scrollX.interpolate({
        inputRange: [0, pageWidth],
        outputRange: [floraColors.gray, floraColors.greenLight],
        extrapolate: "clamp",
      }),
    };
  }, [pageWidth, scrollX]);

  const onPagerScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: false,
      }),
    [scrollX],
  );

  const switchTab = useCallback(
    (next: MusicBrowseTab) => {
      if (next === activeTab) return;
      setActiveTab(next);
      pagerRef.current?.scrollTo({
        x: browseTabIndex(next) * pageWidth,
        animated: true,
      });
    },
    [activeTab, pageWidth],
  );

  const onPagerScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
      const next: MusicBrowseTab = index === 0 ? "recommendations" : "myMusic";
      setActiveTab((current) => (current === next ? current : next));
    },
    [pageWidth],
  );

  const handleUploaded = () => {
    refreshMusic();
    setSearch("");
    setAddTrackOpen(false);
    switchTab("myMusic");
  };

  return (
    <View style={styles.root}>
      <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
        <TabScreenSearchHeader
          title="Музыка"
          placeholder="Поиск по музыке"
          value={search}
          onChangeText={setSearch}
          menuOpen={menuOpen}
          onMenuOpen={() => setMenuOpen(true)}
          onMenuClose={() => setMenuOpen(false)}
          createAction={{
            accessibilityLabel: "Добавить трек",
            onPress: () => setAddTrackOpen(true),
          }}
        />

        <View style={styles.navigationRow}>
          <View style={styles.tabs}>
            {tabIndicatorStyle ? (
              <Animated.View pointerEvents="none" style={[styles.tabIndicator, tabIndicatorStyle]} />
            ) : null}
            <Pressable
              style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
              onLayout={(event) => recordTabLayout("recommendations", event)}
              onPress={() => switchTab("recommendations")}
            >
              <Animated.Text
                style={[
                  styles.tabLabel,
                  tabLabelColors ? { color: tabLabelColors.recommendations } : styles.tabLabelActive,
                ]}
              >
                Рекомендации
              </Animated.Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
              onLayout={(event) => recordTabLayout("myMusic", event)}
              onPress={() => switchTab("myMusic")}
            >
              <Animated.Text
                style={[styles.tabLabel, tabLabelColors ? { color: tabLabelColors.myMusic } : null]}
              >
                Моя музыка
              </Animated.Text>
            </Pressable>
          </View>
        </View>
      </View>

      <View style={[styles.body, { paddingBottom: listPaddingBottom }]}>
        {hasSearch ? (
          <MusicSearchResults query={search} tracks={tracks} />
        ) : loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={floraColors.greenLight} />
            <Text style={styles.emptyHint}>Загрузка музыки…</Text>
          </View>
        ) : (
          <Animated.ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            decelerationRate="fast"
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={onPagerScroll}
            onMomentumScrollEnd={onPagerScrollEnd}
            style={styles.pager}
            contentContainerStyle={styles.pagerContent}
          >
            <MusicPane
              tab="recommendations"
              pageWidth={pageWidth}
              tracks={tracks}
              playlists={playlists}
              refreshing={libraryQuery.isFetching || playlistsQuery.isFetching}
              onRefresh={refreshMusic}
            />
            <MusicPane
              tab="myMusic"
              pageWidth={pageWidth}
              tracks={tracks}
              playlists={playlists}
              refreshing={libraryQuery.isFetching || playlistsQuery.isFetching}
              onRefresh={refreshMusic}
            />
          </Animated.ScrollView>
        )}
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
          <View style={styles.uploadTabs}>
            <MusicTabBar tabs={MUSIC_UPLOAD_TABS} active={uploadTab} onSelect={setUploadTab} compact />
          </View>
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
  topBlock: {
    backgroundColor: floraColors.bg,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: 0,
    gap: 13,
  },
  navigationRow: {
    position: "relative",
    minHeight: 35,
    width: "100%",
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
  },
  tabButton: {
    height: 35,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  tabPressed: {
    opacity: 0.72,
  },
  tabLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 15,
  },
  tabLabelActive: {
    color: floraColors.greenLight,
  },
  tabIndicator: {
    position: "absolute",
    left: 0,
    bottom: 0,
    height: 2,
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
    zIndex: 2,
  },
  body: {
    flex: 1,
  },
  pager: {
    flex: 1,
  },
  pagerContent: {
    flexGrow: 1,
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
