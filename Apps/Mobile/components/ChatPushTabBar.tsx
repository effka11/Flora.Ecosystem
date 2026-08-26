import MaskedView from "@react-native-masked-view/masked-view";
import { BottomTabBar, type BottomTabBarProps } from "expo-router/tabs";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Reanimated, { useAnimatedStyle } from "react-native-reanimated";
import {
  CHAT_PUSH_DIM,
  CHAT_PUSH_PARALLAX,
  chatPushProgress,
} from "@/lib/chatPushTransition";
import { tabBarMaskTranslateXPx, uncoveredWidthPx } from "@/lib/chatPushTabBarClip";
import { floraTabBarContentHeight } from "@/lib/theme";

/**
 * React Navigation зовёт `tabBar` как функцию `tabBar(props)`, не как
 * `<TabBar />`. Без JSX хуки в компоненте — invalid hook call.
 */
export function renderChatPushTabBar(props: BottomTabBarProps) {
  return <ChatPushTabBar {...props} />;
}

/**
 * Таб-бар едет с chat push: тот же progress, что список (параллакс + dim),
 * плюс дырка справа в экранных координатах. Clip — маска на translateX
 * полноширинного белого слоя (не layout-width, не scaleX+inverse, не fade 1-p).
 *
 * Хост только высота бара: absoluteFill накрывал бы весь Tabs и ел тапы
 * по списку (чаты «не открываются»).
 */
export function ChatPushTabBar(props: BottomTabBarProps) {
  const { width: screenWidth } = useWindowDimensions();
  const barHeight = floraTabBarContentHeight() + Math.max(props.insets.bottom, 8);

  const maskStyle = useAnimatedStyle(() => {
    const uncovered = uncoveredWidthPx(chatPushProgress.value, screenWidth);
    return {
      opacity: uncovered <= 0 ? 0 : 1,
      transform: [
        { translateX: tabBarMaskTranslateXPx(chatPushProgress.value, screenWidth) },
      ],
    };
  });

  const parallaxStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: -CHAT_PUSH_PARALLAX * screenWidth * chatPushProgress.value },
    ],
  }));

  const dimStyle = useAnimatedStyle(() => ({
    opacity: CHAT_PUSH_DIM * chatPushProgress.value,
  }));

  return (
    <View pointerEvents="box-none" style={[styles.host, { height: barHeight }]}>
      <MaskedView
        androidRenderingMode="software"
        pointerEvents="box-none"
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
