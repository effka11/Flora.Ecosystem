import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Reanimated, { type SharedValue } from "react-native-reanimated";
import { useSearchChromeLayerStyles } from "@/components/chrome/searchChromeLayers";
import { FloraTabStripEdgeFades } from "@/components/chrome/FloraTabLabel";
import {
  BlendedSearchTabIndicator,
  TabIndicatorBridgeProvider,
} from "@/components/chrome/tabIndicatorBridge";
import { floraColors, floraTabFilter } from "@/lib/theme";

type Props = {
  progress: SharedValue<number>;
  searchMounted: boolean;
  idle: ReactNode;
  search: ReactNode;
  /** Горизонтальный сдвиг ряда вкладок — боковые фейды, как в настройках. */
  stripOffset?: SharedValue<number>;
  stripMaxOffset?: SharedValue<number>;
};

/**
 * Кроссфейд вкладок ↔ тегов: idle непрозрачный, search absolute fill сверху
 * с фоном и opacity p (lerp, без провала). Индикатор — sibling, не фейдится.
 */
export function TabScreenSearchSwap({
  progress,
  searchMounted,
  idle,
  search,
  stripOffset,
  stripMaxOffset,
}: Props) {
  const { searchStyle } = useSearchChromeLayerStyles(progress);

  return (
    <TabIndicatorBridgeProvider>
      <View style={styles.row}>
        <View
          pointerEvents={searchMounted ? "none" : "auto"}
          style={styles.idleLayer}
        >
          {idle}
        </View>
        <Reanimated.View
          collapsable={false}
          needsOffscreenAlphaCompositing
          pointerEvents={searchMounted ? "box-none" : "none"}
          accessibilityElementsHidden={!searchMounted}
          importantForAccessibility={searchMounted ? "auto" : "no-hide-descendants"}
          renderToHardwareTextureAndroid
          style={[styles.searchLayer, searchStyle]}
        >
          {search}
        </Reanimated.View>
        <BlendedSearchTabIndicator progress={progress} />
        {stripOffset && stripMaxOffset ? (
          <FloraTabStripEdgeFades offset={stripOffset} maxOffset={stripMaxOffset} cover={progress} />
        ) : null}
      </View>
    </TabIndicatorBridgeProvider>
  );
}

const styles = StyleSheet.create({
  row: {
    position: "relative",
    minHeight: floraTabFilter.triggerHeight,
    overflow: "visible",
  },
  idleLayer: {
    minHeight: floraTabFilter.triggerHeight,
  },
  searchLayer: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: floraColors.bg,
  },
});
