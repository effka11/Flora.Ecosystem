import MaskedView from "@react-native-masked-view/masked-view";
import { usePathname, useSegments } from "expo-router";
import { BottomTabBar, type BottomTabBarProps } from "expo-router/tabs";
import { useEffect, useState, useSyncExternalStore } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Reanimated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";
import { CHAT_PUSH_OFF_EDGE, chatPushTabBarOffEdgeCommit } from "@/lib/chatListEnterMount";
import {
  CHAT_PUSH_DIM,
  CHAT_PUSH_PARALLAX,
  chatPushProgress,
  composePushProgress,
  getChatPushExiting,
  subscribeChatPush,
  subscribeChatPushDockHits,
} from "@/lib/chatPushTransition";
import { tabBarMaskProgress, tabBarMaskTranslateXPx, uncoveredWidthPx } from "@/lib/chatPushTabBarClip";
import { chatPushTabBarHits } from "@/lib/chatPushTabBarHits";
import { isMessagesInThread, isMessagesInThreadPath, isMessagesThreadSurface } from "@/lib/messagesTabBar";
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
 * Пока открыт маршрут треда, бар не рендерится вовсе (см. return null):
 * его рисует таб-навигатор ПОВЕРХ экрана чата, и никакой z-index внутри треда
 * не поднимет compose-док выше бара. Опора на progress здесь не годится —
 * он может быть сброшен снаружи (activity-return), а док остаётся на месте.
 *
 * Хост только высота бара: absoluteFill накрывал бы весь Tabs и ел тапы
 * по списку. Хиты глушатся, только пока док закрыт (создание поста или чат
 * ещё на экране при стиле `none`). За краем и хост, и стиль панели —
 * `box-none`. Заезд на пороге 0.01 не делает setState. Падение progress
 * до края коммитит chatOffEdge в том же кадре.
 */
export function ChatPushTabBar(props: BottomTabBarProps) {
  const { width: screenWidth } = useWindowDimensions();
  const pathname = usePathname();
  const segments = useSegments();
  const barHeight = floraTabBarContentHeight() + Math.max(props.insets.bottom, 8);
  /**
   * Маршрут треда в стеке. Опора на путь, а не на progress/exiting: чат может
   * быть виден при сброшенном progress, а `exiting` мог остаться от прерванного
   * выхода. Пока маршрут открыт, бар — чужая поверхность снизу.
   */
  const threadRouteOpen = isMessagesThreadSurface({ segments, pathname });
  /**
   * Пока маршрут треда открыт: бар не перехватывает тапы дока и не рисуется
   * над ним, пока чат жив, даже если progress успел сброситься (возврат из
   * системного пикера). Пиксели ведёт progress только когда маршрута треда
   * нет или идёт выход.
   */
  const exiting = useSyncExternalStore(subscribeChatPush, getChatPushExiting);
  const threadOpen =
    !exiting && (isMessagesInThread(segments) || isMessagesInThreadPath(pathname));
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
  useEffect(
    () =>
      subscribeChatPushDockHits((off) => {
        setChatOffEdge(off);
      }),
    [],
  );
  useAnimatedReaction(
    () => chatPushProgress.value,
    (progress, prev) => {
      if (!chatPushTabBarOffEdgeCommit(prev, progress)) return;
      runOnJS(setChatOffEdge)(true);
    },
  );
  const hits = chatPushTabBarHits({
    // В открытом треде бар не должен перехватывать тапы дока даже если
    // progress сбросился раньше, чем фокус вернулся списку.
    styleBlocksHits: tabBarStyleBlocksHits(props),
    threadOpen,
    chatProgress: chatOffEdge ? 0 : 1,
    composeCoversDock: pushCoversDock,
  });
  const hostPointerEvents = hits.host;

  const maskStyle = useAnimatedStyle(() => {
    // Маршрут треда жив — бар не рисуем вовсе: его пиксели не должны всплывать
    // над доком, если progress сбросился снаружи (возврат из пикера). На входе
    // маршрут пушится уже на progress = 1, на выходе threadOpen снят — анимация
    // слайда по-прежнему ведётся progress-ом.
    const progress = tabBarMaskProgress({
      threadOpen,
      chatProgress: chatPushProgress.value,
      composeProgress: composePushProgress.value,
    });
    const uncovered = uncoveredWidthPx(progress, screenWidth);
    return {
      opacity: uncovered <= 0 ? 0 : 1,
      transform: [{ translateX: tabBarMaskTranslateXPx(progress, screenWidth) }],
    };
  }, [threadOpen]);

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

  /**
   * Бар не существует в дереве, пока открыт чат. Таб-навигатор рендерит его
   * после экранов — то есть поверх compose-дока; маска по progress выручала
   * только пока progress жив. Сброс progress (activity-return) возвращал бар,
   * и поле ввода уходило под него.
   */
  if (threadRouteOpen) return null;

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
