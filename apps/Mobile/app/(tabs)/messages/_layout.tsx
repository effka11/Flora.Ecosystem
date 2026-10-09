import { Stack, useNavigation, usePathname, useSegments } from "expo-router";
import { memo, useLayoutEffect, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import { runOnJS, useAnimatedReaction } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThreadScreen } from "./[conversationUuid]";
import {
  CHAT_PUSH_OFF_EDGE,
  chatBenchHostRaised,
  chatPushHostIgnoresHits,
  layoutChatBenchSlots,
} from "@/lib/chatListEnterMount";
import { applyMessagesTabBarHidden, isMessagesInThread, isMessagesInThreadPath } from "@/lib/messagesTabBar";
import {
  chatPushProgress,
  getChatPushEnterPaint,
  getChatPushExiting,
  getChatPushHolding,
  getChatPushOffEdge,
  getChatPushOverlay,
  getChatWarmBench,
  setChatPushOffEdge,
  subscribeChatPush,
  subscribeChatWarm,
} from "@/lib/chatPushTransition";
import { floraColors, floraNativeStackOptions, sPx } from "@/lib/theme";

export default function MessagesLayout() {
  return (
    <View style={styles.shell}>
      <Stack screenOptions={{ ...floraNativeStackOptions, animation: "none" }}>
        {/* freezeOnBlur параллаксу не мешает: на Fabric native-stack не
            замораживает экран прямо под фокусным (!isBelowFocused в
            NativeStackView) — под прозрачным тредом список остаётся живым
            и рендерит параллакс; freeze сработал бы только глубже стека. */}
        <Stack.Screen
          name="index"
          options={{ headerShown: false, animation: "none", freezeOnBlur: true }}
        />
        {/*
          Телеграмный push на языке Flora (см. lib/chatPushTransition.ts):
          нативный переход выключен, хореографию ведёт Reanimated с кривой
          ENERGETIC_OPEN. transparentModal держит список видимым и живым под
          экраном треда — чат заезжает справа непрозрачным слоем, список
          остаётся на месте с параллаксом и затемнением; назад через
          beforeRemove играет то же зеркально. Нативный жест выключен: он не
          умеет играть JS-переход, системный back Android идёт через
          beforeRemove.
        */}
        <Stack.Screen
          name="[conversationUuid]"
          options={{
            headerShown: false,
            presentation: "transparentModal",
            animation: "none",
            contentStyle: { backgroundColor: "transparent" },
            gestureEnabled: false,
          }}
        />
      </Stack>
      <MessagesTabBarGate />
      <ParkedChatHost />
    </View>
  );
}

/**
 * Подписка на парковку живёт здесь, не в лэйауте стека. Иначе press-in
 * перерисовывает список под пальцем, и Pressable теряет отпускание.
 * Парковка не маршрут и не прячет таб-бар.
 */
function MessagesTabBarGate() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const tabBarBottomInset = Math.max(insets.bottom, sPx(8));
  const segments = useSegments();
  const pathname = usePathname();
  const holding = useSyncExternalStore(subscribeChatPush, getChatPushHolding);
  const inThread =
    (isMessagesInThread(segments) || isMessagesInThreadPath(pathname)) && !holding;

  useLayoutEffect(() => {
    applyMessagesTabBarHidden(navigation, tabBarBottomInset, inThread);
  }, [inThread, navigation, tabBarBottomInset]);

  return null;
}

function ParkedChatHost() {
  const parked = useSyncExternalStore(subscribeChatPush, getChatPushOverlay);
  const holding = useSyncExternalStore(subscribeChatPush, getChatPushHolding);
  const offEdge = useSyncExternalStore(subscribeChatPush, getChatPushOffEdge);
  const exiting = useSyncExternalStore(subscribeChatPush, getChatPushExiting);
  const enterPaint = useSyncExternalStore(subscribeChatPush, getChatPushEnterPaint);
  const bench = useSyncExternalStore(subscribeChatWarm, getChatWarmBench);
  useAnimatedReaction(
    () => chatPushProgress.value <= CHAT_PUSH_OFF_EDGE,
    (off, prev) => {
      if (prev != null && off === prev) return;
      runOnJS(setChatPushOffEdge)(off);
    },
  );
  if (!parked && bench.length === 0) return null;
  // Пока чат за правым краем, хост не участник hit-test: transform уводит
  // картинку, но рамка лэйаута остаётся на весь экран и съедала бы тап.
  const activeId = parked?.conversationUuid.trim().toLowerCase() ?? "";
  const slots =
    parked && activeId && !bench.some((slot) => slot.id === activeId)
      ? [...bench, { id: activeId, params: parked, attempt: 0, closed: false }]
      : bench;
  const activeSlot = activeId ? slots.find((slot) => slot.id === activeId) : undefined;
  const hostRaised = chatBenchHostRaised({
    holding,
    offEdge,
    exiting,
    enterPaint,
    carpetDown: activeSlot?.closed ?? true,
  });
  const ignoreHits = !hostRaised || chatPushHostIgnoresHits({ holding, offEdge });
  // Замер — один верхний слот без translateX, под списком. Пока палец держит
  // незакрытый слот, хост не поднимается и кадр замера остаётся у него.
  // Закрытый активный слот при поднятом хосте до runEnter стоит за краем.
  const frames = layoutChatBenchSlots({
    slots,
    activeId: activeId || null,
    hostRaised,
  });
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  return (
    <View
      collapsable={false}
      pointerEvents={ignoreHits ? "none" : "box-none"}
      style={[styles.parkHost, hostRaised ? styles.parkHostRaised : styles.parkHostUnder]}
    >
      {frames.map((frame) => {
        const slot = byId.get(frame.id);
        if (slot == null) return null;
        const active = frame.layer === "active" && parked != null;
        return (
          <View key={slot.id} collapsable={false} pointerEvents="box-none" style={styles.parkSlot}>
            <ParkedThreadSlot
              params={active && parked ? parked : slot.params}
              bench={!active}
              attempt={slot.attempt}
              measureFrame={frame.layer === "measure"}
            />
          </View>
        );
      })}
    </View>
  );
}

const ParkedThreadSlot = memo(function ParkedThreadSlot({
  params,
  bench,
  attempt,
  measureFrame,
}: {
  params: NonNullable<ReturnType<typeof getChatPushOverlay>>;
  bench: boolean;
  /** Повтор yielded-окна: тот же инстанс перепроверяет высоты и круги. */
  attempt: number;
  /** Единственный слот в кадре замера: без translateX и без соседа поверх. */
  measureFrame: boolean;
}) {
  return (
    <ThreadScreen
      overlayParams={params}
      bench={bench}
      benchAttempt={attempt}
      measureFrame={measureFrame}
    />
  );
});

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  parkHost: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  /** Под списком: слот замера в окне, хиты остаются у ленты чатов. */
  parkHostUnder: {
    zIndex: -1,
  },
  /** Подъём после закрытия окна и на enterPaint / exiting. Не анимируется кадром жеста. */
  parkHostRaised: {
    zIndex: 2,
  },
  parkSlot: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
});
