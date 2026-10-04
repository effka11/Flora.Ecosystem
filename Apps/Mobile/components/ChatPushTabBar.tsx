import MaskedView from "@react-native-masked-view/masked-view";
import { BottomTabBar, type BottomTabBarProps } from "expo-router/tabs";
import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Reanimated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";
import {
  CHAT_PUSH_DIM,
  CHAT_PUSH_PARALLAX,
  chatPushProgress,
  composePushProgress,
} from "@/lib/chatPushTransition";
import { tabBarMaskTranslateXPx, uncoveredWidthPx } from "@/lib/chatPushTabBarClip";
import { floraTabBarContentHeight } from "@/lib/theme";

/** Дырка маски визуальная: hit-test всё равно по полной ширине хоста над доком. */
function tabBarStyleBlocksHits(props: BottomTabBarProps): boolean {
  const route = props.state.routes[props.state.index];
  if (route == null) {
    return false;
  }
  const flat = StyleSheet.flatten(props.descriptors[route.key]?.options.tabBarStyle);
  return flat != null && "pointerEvents" in flat && flat.pointerEvents === "none";
}

/**
 * React Navigation зовёт `tabBar` как функцию `tabBar(props)`, не как
 * `<TabBar />`. Без JSX хуки в компоненте — invalid hook call.
 */
export function renderChatPushTabBar(props: BottomTabBarProps) {
  return <ChatPushTabBar {...props} />;
}

/**
 * Таб-бар едет с push чата и создания поста: max двух progress (параллакс +
 * dim), плюс дырка справа в экранных координатах. Clip — маска на translateX
 * полноширинного белого слоя (не layout-width, не scaleX+inverse, не fade 1-p).
 *
 * Хост только высота бара: absoluteFill накрывал бы весь Tabs и ел тапы
 * по списку. Пока верхний экран открыт (tabBarStyle pointerEvents none или
 * progress > 0) хост сам `none` — иначе MaskedView ест док,
 * хотя пикселей справа нет.
 */
export function ChatPushTabBar(props: BottomTabBarProps) {
  const { width: screenWidth } = useWindowDimensions();
  const barHeight = floraTabBarContentHeight() + Math.max(props.insets.bottom, 8);
  const [pushCoversDock, setPushCoversDock] = useState(
    () => Math.max(chatPushProgress.value, composePushProgress.value) > 0.01,
  );
  useAnimatedReaction(
    () => Math.max(chatPushProgress.value, composePushProgress.value) > 0.01,
    (covers, prev) => {
      if (covers !== prev) {
        runOnJS(setPushCoversDock)(covers);
      }
    },
  );
  const passThrough = tabBarStyleBlocksHits(props) || pushCoversDock;
  const hostPointerEvents = passThrough ? "none" : "box-none";

  const maskStyle = useAnimatedStyle(() => {
    const progress = Math.max(chatPushProgress.value, composePushProgress.value);
    const uncovered = uncoveredWidthPx(progress, screenWidth);
    return {
      opacity: uncovered <= 0 ? 0 : 1,
      transform: [{ translateX: tabBarMaskTranslateXPx(progress, screenWidth) }],
    };
  });

  const parallaxStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          -CHAT_PUSH_PARALLAX *
          screenWidth *
          Math.max(chatPushProgress.value, composePushProgress.value),
      },
    ],
  }));

  const dimStyle = useAnimatedStyle(() => ({
    opacity:
      CHAT_PUSH_DIM * Math.max(chatPushProgress.value, composePushProgress.value),
  }));

  return (
    <View pointerEvents={hostPointerEvents} style={[styles.host, { height: barHeight }]}>
      <MaskedView
        androidRenderingMode="software"
        pointerEvents={hostPointerEvents}
        style={styles.mask}
        maskElement={
          <View collapsable={false} pointerEvents="none" style={styles.maskRoot}>
            <Reanimated.View
              pointerEvents="none"
              style={[styles.maskFill, { width: screenWidth }, maskStyle]}
            />
          </View>
        }
      >
        <Reanimated.View pointerEvents="box-none" style={[styles.mask, parallaxStyle]}>
          <BottomTabBar {...props} />
          <Reanimated.View pointerEvents="none" style={[styles.dim, dimStyle]} />
        </Reanimated.View>
      </MaskedView>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  mask: {
    flex: 1,
  },
  maskRoot: {
    flex: 1,
    backgroundColor: "transparent",
  },
  maskFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "#ffffff",
  },
  dim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#000",
    opacity: 0,
  },
});
