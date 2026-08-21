import { Ionicons } from "@expo/vector-icons";
import { useCallback, useMemo, useRef, useState } from "react";
import { Linking, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import {
  Pressable as GesturePressable,
  ScrollView as GestureScrollView,
} from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FLORA_TAB_STRIP_PAD_X } from "@/components/chrome/FloraTabChipStrip";
import { FloraTabLabel, floraTabChrome } from "@/components/chrome/FloraTabLabel";
import { TabPagerPage, TabPagerTrack } from "@/components/chrome/TabPager";
import { SyncPagerTabIndicator } from "@/components/chrome/tabIndicatorBridge";
import { TabScreenHeader } from "@/components/TabScreenHeader";
import { floraColors, floraSpacing, floraTabBarContentPadding } from "@/lib/theme";
import { bindChipStripBusy, usePagerBusyFlags } from "@/lib/usePagerBusyFlags";
import { useTabPager } from "@/lib/useTabPager";

type ContributeTabId = "development" | "donations";

type TabLayout = { x: number; width: number };

const CONTRIBUTE_TABS: readonly { id: ContributeTabId; label: string }[] = [
  { id: "development", label: "Разработка" },
  { id: "donations", label: "Пожертвования" },
];

const GITHUB_REPO_URL = "https://github.com/effka11/Flora.Ecosystem";
const BOOSTY_DONATE_URL = "https://boosty.to/flora_studio/donate";

const DEVELOPMENT_LEAD =
  "Код Flora открытый. Можно просто посмотреть, как всё устроено.";

const DEVELOPMENT_NOTE =
  "Можно написать про ошибку или помочь с разработкой, если захочется.";

const DONATIONS_LEAD =
  "Рекламы у нас нет и не будет. Ваши данные мы не продаём.";

const DONATIONS_NOTE =
  "Можно поддержать, если захочется, а можно просто пользоваться дальше. Flora открыта для всех.";

function contributeTabIndex(tab: ContributeTabId) {
  return tab === "development" ? 0 : 1;
}

type PaneProps = {
  pageWidth: number;
  listPaddingBottom: number;
  isActive: boolean;
};

function DevelopmentPane({ pageWidth, listPaddingBottom, isActive }: PaneProps) {
  const openRepo = () => {
    void Linking.openURL(GITHUB_REPO_URL);
  };

  return (
    <TabPagerPage pageWidth={pageWidth}>
      <GestureScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: listPaddingBottom }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        scrollEnabled={isActive}
        nestedScrollEnabled={false}
        overScrollMode={isActive ? "auto" : "never"}
      >
        <View style={styles.copyBlock}>
          <Text style={styles.description}>{DEVELOPMENT_LEAD}</Text>
          <Text style={styles.description}>{DEVELOPMENT_NOTE}</Text>
        </View>

        <GesturePressable
          accessibilityRole="link"
          accessibilityLabel="Открыть репозиторий Flora.Ecosystem на GitHub"
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          onPress={openRepo}
        >
          <Ionicons name="logo-github" size={20} color={floraColors.bg} />
          <Text style={styles.primaryBtnLabel}>Открыть на GitHub</Text>
        </GesturePressable>
      </GestureScrollView>
    </TabPagerPage>
  );
}

function DonationsPane({ pageWidth, listPaddingBottom, isActive }: PaneProps) {
  const openBoosty = () => {
    void Linking.openURL(BOOSTY_DONATE_URL);
  };

  return (
    <TabPagerPage pageWidth={pageWidth}>
      <GestureScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: listPaddingBottom }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        scrollEnabled={isActive}
        nestedScrollEnabled={false}
        overScrollMode={isActive ? "auto" : "never"}
      >
        <View style={styles.copyBlock}>
          <Text style={styles.description}>{DONATIONS_LEAD}</Text>
          <Text style={styles.description}>{DONATIONS_NOTE}</Text>
        </View>

        <GesturePressable
          accessibilityRole="link"
          accessibilityLabel="Пожертвовать на Boosty"
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          onPress={openBoosty}
        >
          <Ionicons name="heart" size={20} color={floraColors.bg} />
          <Text style={styles.primaryBtnLabel}>Пожертвовать на Boosty</Text>
        </GesturePressable>
      </GestureScrollView>
    </TabPagerPage>
  );
}

export default function ContributeScreen() {
  const insets = useSafeAreaInsets();
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const pagerGenRef = useRef(0);
  const { reportTouch, reportPager, reportStrip } = usePagerBusyFlags();
  const chipStripBusy = useMemo(
    () => bindChipStripBusy(reportTouch, reportStrip),
    [reportStrip, reportTouch],
  );
  const [activeTab, setActiveTab] = useState<ContributeTabId>("development");
  const [tabLayouts, setTabLayouts] = useState<Record<ContributeTabId, TabLayout | null>>({
    development: null,
    donations: null,
  });

  const recordTabLayout = useCallback((tab: ContributeTabId, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[tab];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [tab]: { x, width } };
    });
  }, []);

  const commitPagerIndex = useCallback((index: number) => {
    const next: ContributeTabId = index === 0 ? "development" : "donations";
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
    initialIndex: 0,
    onTouchBegin: () => reportTouch(true),
    onTouchEnd: () => reportTouch(false),
    onPagerStart: () => {
      pagerGenRef.current = reportPager(true);
    },
    onMotionEnd: () => {
      reportPager(false, pagerGenRef.current);
    },
    onCommitIndex: commitPagerIndex,
  });

  const selectTab = useCallback(
    (next: ContributeTabId) => {
      const index = contributeTabIndex(next);
      if (index === pagerTargetRef.current) return;
      settleToIndex(index);
    },
    [pagerTargetRef, settleToIndex],
  );

  return (
    <View style={styles.root}>
      <TabScreenHeader
        title="Помощь проекту"
        searchEnabled={false}
        onChipPanBegin={chipStripBusy.onChipPanBegin}
        onChipPanFinalize={chipStripBusy.onChipPanFinalize}
        onChipPanDecayEnd={chipStripBusy.onChipPanDecayEnd}
        idle={({ stripOffset }) => (
          <View style={styles.tabs}>
            <SyncPagerTabIndicator
              scrollX={scrollX}
              pageWidth={pageWidth}
              start={tabLayouts.development}
              end={tabLayouts.donations}
              insetX={FLORA_TAB_STRIP_PAD_X}
              stripOffset={stripOffset}
            />
            {CONTRIBUTE_TABS.map((tab, index) => (
              <GesturePressable
                key={tab.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: activeTab === tab.id }}
                style={floraTabChrome.tabButton}
                onLayout={(event) => recordTabLayout(tab.id, event)}
                onPress={() => selectTab(tab.id)}
              >
                <FloraTabLabel index={index} label={tab.label} progress={tabProgress} />
              </GesturePressable>
            ))}
          </View>
        )}
      />

      <View style={styles.body} onLayout={onBodyLayout}>
        <View style={styles.pagerHost}>
          <TabPagerTrack pageCount={2} pageWidth={pageWidth} pagerPan={pagerPan} scrollX={scrollX}>
            <DevelopmentPane
              pageWidth={pageWidth}
              listPaddingBottom={listPaddingBottom}
              isActive={activeTab === "development"}
            />
            <DonationsPane
              pageWidth={pageWidth}
              listPaddingBottom={listPaddingBottom}
              isActive={activeTab === "donations"}
            />
          </TabPagerTrack>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  body: {
    flex: 1,
    overflow: "hidden",
  },
  pagerHost: {
    flex: 1,
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: floraSpacing.grid,
    paddingTop: floraSpacing.grid * 2,
    gap: floraSpacing.grid * 2,
  },
  copyBlock: {
    gap: floraSpacing.grid,
  },
  description: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: floraSpacing.gridFine * 2,
    minHeight: 45,
    borderRadius: 12,
    backgroundColor: floraColors.greenLight,
    paddingHorizontal: floraSpacing.grid * 2,
  },
  primaryBtnLabel: {
    color: floraColors.bg,
    fontSize: 15,
    fontWeight: "400",
    letterSpacing: 0.45,
  },
  pressed: {
    opacity: 0.72,
  },
});
