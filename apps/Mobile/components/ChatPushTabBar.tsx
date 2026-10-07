import MaskedView from "@react-native-masked-view/masked-view";
import { BottomTabBar, type BottomTabBarProps } from "expo-router/tabs";
import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Reanimated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";
import { CHAT_PUSH_OFF_EDGE } from "@/lib/chatListEnterMount";
import {
  CHAT_PUSH_DIM,
  CHAT_PUSH_PARALLAX,
  chatPushProgress,
  composePushProgress,
} from "@/lib/chatPushTransition";
import { tabBarMaskTranslateXPx, uncoveredWidthPx } from "@/lib/chatPushTabBarClip";
import { chatPushTabBarHits } from "@/lib/chatPushTabBarHits";
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
 * `none` на стиле самой панели хост не перекрывает — то же значение предиката
 * уходит в tabBarStyle, который читает BottomTabBar.
 */
function withTabBarPointerEvents(
  props: BottomTabBarProps,
  pointerEvents: "none" | "box-none",
): BottomTabBarProps {
  const route = props.state.routes[props.state.index];
  if (route == null) {
    return props;
  }
  const descriptor = props.descriptors[route.key];
  if (descriptor == null) {
    return props;
  }
  const flat = StyleSheet.flatten(descriptor.options.tabBarStyle);
  const current = flat != null && "pointerEvents" in flat ? flat.pointerEvents : undefined;
  if (current === pointerEvents) {
    return props;
  }
  return {
    ...props,
    descriptors: {
      ...props.descriptors,
      [route.key]: {
        ...descriptor,
        options: {
          ...descriptor.options,
          tabBarStyle: [descriptor.options.tabBarStyle, { pointerEvents }],
        },
      },
    },
  };
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
 * по списку. Хиты глушатся, только пока док закрыт (создание поста или чат
 * ещё на экране при стиле `none`). За краем и хост, и стиль панели —
 * `box-none`. Слайд не дёргает React, пока кадр не пересёк порог.
 */
export function ChatPushTabBar(props: BottomTabBarProps) {
  const { width: screenWidth } = useWindowDimensions();
  const barHeight = floraTabBarContentHeight() + Math.max(props.insets.bottom, 8);
  const [pushCoversDock, setPushCoversDock] = useState(() => composePushProgress.value > 0.01);
  useAnimatedReaction(
    () => composePushProgress.value > 0.01,
    (covers, prev) => {
      if (covers !== prev) {
        runOnJS(setPushCoversDock)(covers);
      }
    },
  );
  const [chatOffEdge, setChatOffEdge] = useState(
    () => chatPushProgress.value <= CHAT_PUSH_OFF_EDGE,
  );
  useAnimatedReaction(
    () => chatPushProgress.value <= CHAT_PUSH_OFF_EDGE,
    (off, prev) => {
      if (off !== prev) {
        runOnJS(setChatOffEdge)(off);
      }
    },
  );
  const hits = chatPushTabBarHits({
    styleBlocksHits: tabBarStyleBlocksHits(props),
    chatProgress: chatOffEdge ? 0 : 1,
    composeCoversDock: pushCoversDock,
  });
  const hostPointerEvents = hits.host;

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
          <BottomTabBar {...withTabBarPointerEvents(props, hits.tabBar)} />
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
