import { useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, Keyboard, Platform, type ViewStyle } from "react-native";
import {
  KeyboardController,
  KeyboardEvents,
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import type Reanimated from "react-native-reanimated";
import {
  cancelAnimation,
  Easing as ReanimatedEasing,
  runOnJS,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useScrollOffset,
  useSharedValue,
  withTiming,
  type AnimatedRef,
  type AnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import {
  commitImeHeightPx,
  getBootstrapImeHeightPx,
  getCachedImeHeightPx,
  migrateLegacyImeHeight,
} from "@/lib/imeHeightStore";
import {
  CHAT_AT_BOTTOM_THRESHOLD_PX,
  COMPOSE_BASELINE_FALLBACK_PX,
  emojiPanelDockHeightPx,
  keyboardStickyOffsets,
} from "@/lib/messagesDockInsets";
import { floraSpacing } from "@/lib/theme";

/**
 * Compose dock v11 — единый Reanimated-конвейер, один «писатель» скролла.
 *
 * Геометрия. Док — absolute-оверлей у нижней грани экрана; его layout не
 * влияет на ленту. Подъём раскладывается на два слагаемых:
 *  - translateY дока = ksvClosed - kbLift — чистый follower клавиатуры (transform);
 *  - высота слота под полем = max(0, emojiLift - kbLift) — заполняет зазор
 *    между полем ввода и клавиатурой/низом экрана.
 * Позиция поля ввода = idle + max(kbLift, emojiLift) = idle + totalLift.
 * При переключении «клавиатура <-> эмодзи» totalLift константен по построению —
 * поле стоит на месте, панели меняются под ним (Telegram-паттерн).
 *
 * Лента. Клавиатурная механика KeyboardChatScrollView всегда заморожена
 * (freeze=true): её внутренний padding не растёт и она не скроллит. Весь
 * bottom-inset идёт одним shared value (extraContentPadding = navInset +
 * column + insetLift), где insetLift — «потолок» подъёма: расширяется до цели
 * в начале движения (чтобы worklet-scrollTo не клампился о старый диапазон)
 * и оседает к фактическому lift на осадке. Скролл докручивает единственный
 * worklet этого хука (whenAtEnd-семантика). Один писатель — нет гонок scrollTo.
 */

const KB_HEIGHT_EPSILON_PX = 2;
const KB_PROGRESS_SETTLED = 0.999;
const PANEL_OPEN_MS = Platform.OS === "ios" ? 250 : 220;
const PANEL_CLOSE_MS = 200;
const PANEL_RELEASE_MS = 160;
const PANEL_EASING = ReanimatedEasing.out(ReanimatedEasing.cubic);

export type ChatComposeDockConfig = {
  /** Нижний системный инсет (nav bar) — из resolveMessagesDockBottomInset. */
  systemNavBottomInsetPx: number;
};

export type ChatComposeDock = {
  /** translateY дока — замена KeyboardStickyView (док = absolute-оверлей снизу). */
  dockStickyStyle: AnimatedStyle<ViewStyle>;
  /** Анимированная высота слота панели (под полем ввода, overflow hidden). */
  emojiSlotStyle: AnimatedStyle<ViewStyle>;
  jumpBtnBottomStyle: AnimatedStyle<ViewStyle>;
  /** Полный bottom-inset ленты: navInset + column + insetLift. */
  dockExtraPaddingSv: SharedValue<number>;
  /** Библиотечную механику клавиатуры держим замороженной всегда. */
  freezeListSv: SharedValue<boolean>;
  /** Animated-ref внутреннего скролла ленты (для worklet-скролла). */
  listAnimatedRef: AnimatedRef<Reanimated.ScrollView>;
  onListLayout: (height: number) => void;
  onListContentSizeChange: (height: number) => void;
  composeBaselinePx: number;
  /** Фиксированная высота контента панели (top-anchored внутри слота). */
  emojiPanelHeightPx: number;
  onComposeShellLayout: (height: number) => void;
  onDockColumnIdleLayout: (height: number) => void;
  setDeleteBarHeightPx: (height: number) => void;
  recalibrateComposeBaseline: () => void;
  emojiPanelMounted: boolean;
  emojiAccessoryActive: boolean;
  keyboardOpen: boolean;
  composeDockActive: boolean;
  openEmoji: () => void;
  closeEmoji: () => void;
  /** Эмодзи -> клавиатура: переключает режим и просит IME через showInput(). */
  showKeyboard: (showInput: () => void) => void;
  dismissKeyboard: () => void;
  resetDock: () => void;
};

function sanitizeKbHeightPx(h: number): number {
  return Math.max(0, h);
}

export function useChatComposeDock(config: ChatComposeDockConfig): ChatComposeDock {
  const { systemNavBottomInsetPx } = config;
  const { closed: ksvClosedPx, opened: ksvOpenedPx } = keyboardStickyOffsets(
    systemNavBottomInsetPx,
  );
  /** lift(progress=1) = kbHeight - liftLossPx. Android: navInset, iOS: 0. */
  const liftLossPx = ksvOpenedPx - ksvClosedPx;
  /** Постоянная часть inset ленты помимо колонки: зазор дока над низом окна. */
  const dockIdleGapPx = -ksvClosedPx;

  const [composeBaselinePx, setComposeBaselinePx] = useState(0);
  const [emojiPanelMounted, setEmojiPanelMounted] = useState(false);
  const [emojiPanelHeightPx, setEmojiPanelHeightPx] = useState(0);
  const [emojiAccessoryActive, setEmojiAccessoryActive] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const { height: kbHeightSv, progress: kbProgressSv } =
    useReanimatedKeyboardAnimation();

  const emojiLiftSv = useSharedValue(0);
  /** Потолок подъёма для inset ленты (расширяем заранее, оседаем на onEnd). */
  const insetLiftSv = useSharedValue(0);
  const composeGrowthSv = useSharedValue(0);
  const deleteBarHeightSv = useSharedValue(0);
  const dockExtraPaddingSv = useSharedValue(
    dockIdleGapPx + COMPOSE_BASELINE_FALLBACK_PX,
  );
  const composeBaselineSv = useSharedValue(COMPOSE_BASELINE_FALLBACK_PX);
  const freezeListSv = useSharedValue(true);
  /** true = панель — целевой режим (иконка «клавиатура», IME не запрошен). */
  const emojiActiveSv = useSharedValue(false);

  const emojiActiveRef = useRef(false);
  const emojiPanelMountedRef = useRef(false);
  const composeBaselineRef = useRef(0);

  // --- Лента: состояние для единственного писателя скролла ---

  const listAnimatedRef = useAnimatedRef<Reanimated.ScrollView>();
  const listScrollOffsetSv = useScrollOffset(listAnimatedRef);
  const listLayoutHeightSv = useSharedValue(0);
  const listContentHeightSv = useSharedValue(0);

  const onListLayout = useCallback(
    (height: number) => {
      if (height > 0) listLayoutHeightSv.value = height;
    },
    [listLayoutHeightSv],
  );

  const onListContentSizeChange = useCallback(
    (height: number) => {
      if (height >= 0) listContentHeightSv.value = height;
    },
    [listContentHeightSv],
  );

  useEffect(() => {
    migrateLegacyImeHeight();
  }, []);

  // --- Геометрия подъёма ---

  /**
   * Подъём дока от idle, ведомый клавиатурой. Эквивалент формулы KSV:
   * translateY = kbHeight + interp(progress, closed..opened);
   * lift = closed - translateY. kbHeightSv отрицателен при открытой клавиатуре.
   */
  const kbLiftSv = useDerivedValue(
    () => Math.max(0, -kbHeightSv.value - liftLossPx * kbProgressSv.value),
    [liftLossPx],
  );

  const totalLiftSv = useDerivedValue(() =>
    Math.max(kbLiftSv.value, emojiLiftSv.value),
  );

  const slotHeightSv = useDerivedValue(() =>
    Math.max(0, emojiLiftSv.value - kbLiftSv.value),
  );

  const dockStickyStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateY: ksvClosedPx - kbLiftSv.value }],
    }),
    [ksvClosedPx],
  );

  const emojiSlotStyle = useAnimatedStyle(() => ({
    height: slotHeightSv.value,
  }));

  useAnimatedReaction(
    () => ({
      insetLift: Math.max(insetLiftSv.value, totalLiftSv.value),
      growth: composeGrowthSv.value,
      deleteBar: deleteBarHeightSv.value,
      baseline: composeBaselineSv.value,
    }),
    (cur) => {
      dockExtraPaddingSv.value =
        dockIdleGapPx + cur.baseline + cur.growth + cur.deleteBar + cur.insetLift;
    },
    [dockIdleGapPx],
  );

  /** Кнопка «новые сообщения» ездит за фактическим (не потолочным) подъёмом. */
  const jumpBtnBottomStyle = useAnimatedStyle(
    () => ({
      bottom:
        dockIdleGapPx +
        composeBaselineSv.value +
        composeGrowthSv.value +
        deleteBarHeightSv.value +
        totalLiftSv.value +
        floraSpacing.grid,
    }),
    [dockIdleGapPx],
  );

  // --- Единственный писатель скролла ленты ---

  const followArmedSv = useSharedValue(false);
  const followSuppressedSv = useSharedValue(false);
  const followBaseScrollSv = useSharedValue(-1);
  const followBaseLiftSv = useSharedValue(0);

  /**
   * Подъём/спуск дока: на первом кадре движения фиксируем якорь (offset и
   * «был ли пользователь у низа» — против inset, соответствующего ПРЕЖНЕМУ
   * подъёму, а не уже расширенному потолку), дальше ведём абсолютной целью
   * base + delta — без накопления дрейфа. Без якоря вниз не скроллим,
   * только клампим офсет к сжимающемуся диапазону.
   */
  useAnimatedReaction(
    () => totalLiftSv.value,
    (cur, prev) => {
      if (prev === null || cur === prev) return;

      const columnPad =
        dockIdleGapPx +
        composeBaselineSv.value +
        composeGrowthSv.value +
        deleteBarHeightSv.value;

      if (!followArmedSv.value) {
        followArmedSv.value = true;
        followBaseLiftSv.value = prev;
        const contentH = listContentHeightSv.value;
        const atEnd =
          contentH > 0 &&
          listScrollOffsetSv.value + listLayoutHeightSv.value >=
            contentH + columnPad + prev - CHAT_AT_BOTTOM_THRESHOLD_PX;
        followBaseScrollSv.value =
          atEnd && !followSuppressedSv.value ? listScrollOffsetSv.value : -1;
      }

      if (followBaseScrollSv.value >= 0) {
        scrollTo(
          listAnimatedRef,
          0,
          Math.max(0, followBaseScrollSv.value + (cur - followBaseLiftSv.value)),
          false,
        );
      } else if (cur < prev) {
        // Кламп к дну: офсет не должен превышать сжимающийся диапазон.
        const maxScroll = Math.max(
          0,
          listContentHeightSv.value - listLayoutHeightSv.value + columnPad + cur,
        );
        if (listScrollOffsetSv.value > maxScroll) {
          scrollTo(listAnimatedRef, 0, maxScroll, false);
        }
      }

      if (cur <= KB_HEIGHT_EPSILON_PX) {
        followArmedSv.value = false;
        followSuppressedSv.value = false;
      }
    },
    [dockIdleGapPx],
  );

  /**
   * Дискретные изменения (рост поля, delete-bar): одиночный сдвиг/кламп.
   * Отложен на кадр (rAF на UI-потоке), чтобы native-inset успел расшириться —
   * тот же приём, что в useExtraContentPadding библиотеки.
   */
  useAnimatedReaction(
    () => composeGrowthSv.value + deleteBarHeightSv.value,
    (cur, prev) => {
      if (prev === null) return;
      const delta = cur - prev;
      if (delta === 0) return;
      const contentH = listContentHeightSv.value;
      if (contentH <= 0) return;

      const basePad =
        dockIdleGapPx +
        composeBaselineSv.value +
        Math.max(insetLiftSv.value, totalLiftSv.value);
      const atEnd =
        listScrollOffsetSv.value + listLayoutHeightSv.value >=
        contentH + basePad + prev - CHAT_AT_BOTTOM_THRESHOLD_PX;

      if (atEnd) {
        const target = Math.max(0, listScrollOffsetSv.value + delta);
        requestAnimationFrame(() => {
          scrollTo(listAnimatedRef, 0, target, false);
        });
        return;
      }
      if (delta < 0) {
        const maxScroll = Math.max(
          0,
          contentH - listLayoutHeightSv.value + basePad + cur,
        );
        if (listScrollOffsetSv.value > maxScroll) {
          scrollTo(listAnimatedRef, 0, maxScroll, false);
        }
      }
    },
    [dockIdleGapPx],
  );

  // --- Высота IME ---

  const resolveColdPanelHeightPx = useCallback(() => {
    const cached = getCachedImeHeightPx();
    const stateH = sanitizeKbHeightPx(KeyboardController.state().height);
    const baseKbH =
      cached > KB_HEIGHT_EPSILON_PX
        ? cached
        : stateH > KB_HEIGHT_EPSILON_PX
          ? stateH
          : getBootstrapImeHeightPx();
    return emojiPanelDockHeightPx(
      baseKbH,
      ksvClosedPx,
      ksvOpenedPx,
      Dimensions.get("window").height,
    );
  }, [ksvClosedPx, ksvOpenedPx]);

  const commitCanonicalImeHeight = useCallback((px: number) => {
    commitImeHeightPx(sanitizeKbHeightPx(px));
  }, []);

  // --- Baseline поля ввода ---

  const commitComposeBaseline = useCallback(
    (shellHeight: number) => {
      const prev = composeBaselineRef.current;
      const baseline =
        Platform.OS === "android"
          ? prev > 0
            ? prev
            : shellHeight
          : prev > 0
            ? Math.min(prev, shellHeight)
            : shellHeight;
      if (prev !== baseline || prev <= 0) {
        composeBaselineRef.current = baseline;
        composeBaselineSv.value = baseline;
        setComposeBaselinePx(baseline);
      }
      composeGrowthSv.value = Math.max(0, shellHeight - baseline);
    },
    [composeBaselineSv, composeGrowthSv],
  );

  const onComposeShellLayout = useCallback(
    (height: number) => {
      if (height <= 0) return;
      if (emojiPanelMountedRef.current) {
        // Пока панель открыта, baseline не калибруем — только рост поля.
        const baseline = composeBaselineRef.current || COMPOSE_BASELINE_FALLBACK_PX;
        composeGrowthSv.value = Math.max(0, height - baseline);
        return;
      }
      commitComposeBaseline(height);
    },
    [commitComposeBaseline, composeGrowthSv],
  );

  const onDockColumnIdleLayout = useCallback(
    (height: number) => {
      if (height <= 0) return;
      if (composeBaselineRef.current > 0) return;
      if (emojiPanelMountedRef.current) return;
      const shellOnly = height - deleteBarHeightSv.value;
      if (shellOnly <= 0) return;
      commitComposeBaseline(shellOnly);
    },
    [commitComposeBaseline, deleteBarHeightSv],
  );

  const recalibrateComposeBaseline = useCallback(() => {
    if (emojiPanelMountedRef.current) return;
    composeBaselineRef.current = 0;
    composeBaselineSv.value = COMPOSE_BASELINE_FALLBACK_PX;
    setComposeBaselinePx(0);
    composeGrowthSv.value = 0;
  }, [composeBaselineSv, composeGrowthSv]);

  const setDeleteBarHeightPx = useCallback(
    (height: number) => {
      deleteBarHeightSv.value = height;
    },
    [deleteBarHeightSv],
  );

  // --- Панель: открытие / закрытие / переключения ---

  const mountEmojiPanel = useCallback((heightPx: number) => {
    emojiPanelMountedRef.current = true;
    setEmojiPanelMounted(true);
    setEmojiPanelHeightPx(Math.round(heightPx));
  }, []);

  const unmountEmojiPanel = useCallback(() => {
    emojiPanelMountedRef.current = false;
    setEmojiPanelMounted(false);
  }, []);

  const currentKbLiftPx = useCallback(
    () => Math.max(0, -kbHeightSv.value - liftLossPx * kbProgressSv.value),
    [kbHeightSv, kbProgressSv, liftLossPx],
  );

  const openEmoji = useCallback(() => {
    if (emojiActiveRef.current) return;

    const kbLiftNow = currentKbLiftPx();
    const hot = kbLiftNow > KB_HEIGHT_EPSILON_PX;
    const kbSettled = kbProgressSv.value >= KB_PROGRESS_SETTLED;
    // Живой подъём точнее кеша: при переключении с осевшей клавиатуры панель
    // занимает ровно текущий подъём — слот стартует с 0 и растёт по мере её
    // ухода, поле ввода не шевелится. Если клавиатура ещё в полёте, берём
    // максимум с кешем, чтобы не зафиксировать половинную высоту.
    const target = hot
      ? kbSettled
        ? kbLiftNow
        : Math.max(kbLiftNow, resolveColdPanelHeightPx())
      : resolveColdPanelHeightPx();

    emojiActiveRef.current = true;
    emojiActiveSv.value = true;
    setEmojiAccessoryActive(true);
    mountEmojiPanel(target);

    cancelAnimation(emojiLiftSv);
    insetLiftSv.value = Math.max(insetLiftSv.value, target);
    if (hot) {
      if (target > kbLiftNow + KB_HEIGHT_EPSILON_PX) {
        // Клавиатура ещё в полёте, а цель выше её текущего подъёма: якорим
        // на kbLiftNow и доезжаем анимацией — totalLift непрерывен, без скачка.
        emojiLiftSv.value = kbLiftNow;
        emojiLiftSv.value = withTiming(target, {
          duration: PANEL_OPEN_MS,
          easing: PANEL_EASING,
        });
      } else {
        emojiLiftSv.value = target;
      }
      setKeyboardOpen(false);
      // keepFocus: каретка остаётся в поле (Telegram-паттерн), IME уезжает.
      void KeyboardController.dismiss({ keepFocus: true });
    } else {
      followArmedSv.value = false;
      followSuppressedSv.value = false;
      emojiLiftSv.value = withTiming(
        target,
        { duration: PANEL_OPEN_MS, easing: PANEL_EASING },
        (finished) => {
          "worklet";
          if (finished) {
            insetLiftSv.value = totalLiftSv.value;
          }
        },
      );
    }

    if (__DEV__) {
      console.debug("[chat-compose-dock] open-emoji", { hot, kbSettled, target });
    }
  }, [
    currentKbLiftPx,
    emojiActiveSv,
    emojiLiftSv,
    followArmedSv,
    followSuppressedSv,
    insetLiftSv,
    kbProgressSv,
    mountEmojiPanel,
    resolveColdPanelHeightPx,
    totalLiftSv,
  ]);

  const closeEmoji = useCallback(() => {
    if (!emojiActiveRef.current && !emojiPanelMountedRef.current) return;

    emojiActiveRef.current = false;
    emojiActiveSv.value = false;
    setEmojiAccessoryActive(false);

    followArmedSv.value = false;
    followSuppressedSv.value = false;
    cancelAnimation(emojiLiftSv);
    emojiLiftSv.value = withTiming(
      0,
      { duration: PANEL_CLOSE_MS, easing: PANEL_EASING },
      (finished) => {
        "worklet";
        if (finished) {
          insetLiftSv.value = totalLiftSv.value;
          runOnJS(unmountEmojiPanel)();
        }
      },
    );
  }, [
    emojiActiveSv,
    emojiLiftSv,
    followArmedSv,
    followSuppressedSv,
    insetLiftSv,
    totalLiftSv,
    unmountEmojiPanel,
  ]);

  const showKeyboard = useCallback(
    (showInput: () => void) => {
      if (emojiActiveRef.current) {
        emojiActiveRef.current = false;
        emojiActiveSv.value = false;
        setEmojiAccessoryActive(false);
      }
      // Панель остаётся смонтированной: клавиатура накрывает её, слот
      // сжимается воркалетом, остаток отпускаем на onEnd клавиатуры.
      showInput();
    },
    [emojiActiveSv],
  );

  const dismissKeyboard = useCallback(() => {
    Keyboard.dismiss();
    setKeyboardOpen(false);
  }, []);

  /**
   * Клавиатура пошла вверх (кнопка, тап по инпуту, авто-фокус): переключаем
   * режим/иконку сразу; геометрию ведут воркалеты.
   */
  useEffect(() => {
    const onKeyboardShow = () => {
      setKeyboardOpen(true);
      if (emojiActiveRef.current) {
        emojiActiveRef.current = false;
        emojiActiveSv.value = false;
        setEmojiAccessoryActive(false);
      }
    };
    const willShowSub = KeyboardEvents.addListener("keyboardWillShow", onKeyboardShow);
    const didShowSub = KeyboardEvents.addListener("keyboardDidShow", onKeyboardShow);
    const didHideSub = KeyboardEvents.addListener("keyboardDidHide", () => {
      if (!emojiActiveRef.current) {
        setKeyboardOpen(false);
      }
    });
    return () => {
      willShowSub.remove();
      didShowSub.remove();
      didHideSub.remove();
    };
  }, [emojiActiveSv]);

  useKeyboardHandler(
    {
      onStart: (e) => {
        "worklet";
        // Каждое движение клавиатуры — свежий якорь скролла.
        followArmedSv.value = false;
        followSuppressedSv.value = false;
        if (e.height > KB_HEIGHT_EPSILON_PX) {
          // Открытие: заранее расширяем диапазон под целевой подъём.
          const targetLift = Math.max(0, e.height - liftLossPx);
          insetLiftSv.value = Math.max(insetLiftSv.value, targetLift);
        }
      },
      onInteractive: () => {
        "worklet";
        // Свайп-дисмисс: палец владеет лентой, follower не тянет — только кламп.
        if (!followSuppressedSv.value) {
          followSuppressedSv.value = true;
          followArmedSv.value = false;
          followBaseScrollSv.value = -1;
        }
      },
      onEnd: (e) => {
        "worklet";
        followArmedSv.value = false;
        followSuppressedSv.value = false;

        const releasePanelRemainder = () => {
          emojiLiftSv.value = withTiming(
            0,
            { duration: PANEL_RELEASE_MS, easing: PANEL_EASING },
            (finished) => {
              "worklet";
              if (finished) {
                insetLiftSv.value = totalLiftSv.value;
                runOnJS(unmountEmojiPanel)();
              }
            },
          );
        };

        if (e.height <= KB_HEIGHT_EPSILON_PX) {
          // Клавиатура полностью ушла. Если панель не является целевым
          // режимом (например back в середине перехода эмодзи->клавиатура),
          // не даём ей «залипнуть» — плавно опускаем остаток.
          if (!emojiActiveSv.value && emojiLiftSv.value > 0) {
            releasePanelRemainder();
          } else {
            insetLiftSv.value = totalLiftSv.value;
          }
          return;
        }

        runOnJS(commitCanonicalImeHeight)(e.height);
        if (emojiActiveSv.value || emojiLiftSv.value <= 0) {
          insetLiftSv.value = totalLiftSv.value;
          return;
        }
        // Клавиатура осела поверх панели: плавно отпустить остаток слота
        // (если новая клавиатура ниже панели) и размонтировать контент.
        releasePanelRemainder();
      },
    },
    [commitCanonicalImeHeight, liftLossPx, unmountEmojiPanel],
  );

  const resetDockInner = useCallback(() => {
    emojiActiveRef.current = false;
    emojiActiveSv.value = false;
    cancelAnimation(emojiLiftSv);
    emojiLiftSv.value = 0;
    insetLiftSv.value = 0;
    followArmedSv.value = false;
    followSuppressedSv.value = false;
    followBaseScrollSv.value = -1;
    unmountEmojiPanel();
    setEmojiAccessoryActive(false);
    setKeyboardOpen(false);
    composeGrowthSv.value = 0;
    deleteBarHeightSv.value = 0;
    composeBaselineRef.current = 0;
    composeBaselineSv.value = COMPOSE_BASELINE_FALLBACK_PX;
    setComposeBaselinePx(0);
    Keyboard.dismiss();
  }, [
    composeBaselineSv,
    composeGrowthSv,
    deleteBarHeightSv,
    emojiActiveSv,
    emojiLiftSv,
    followArmedSv,
    followBaseScrollSv,
    followSuppressedSv,
    insetLiftSv,
    unmountEmojiPanel,
  ]);

  const resetDockRef = useRef(resetDockInner);
  resetDockRef.current = resetDockInner;
  const resetDock = useCallback(() => {
    resetDockRef.current();
  }, []);

  useEffect(() => {
    return () => {
      cancelAnimation(emojiLiftSv);
      emojiLiftSv.value = 0;
      insetLiftSv.value = 0;
      emojiActiveSv.value = false;
      emojiActiveRef.current = false;
      emojiPanelMountedRef.current = false;
    };
  }, [emojiActiveSv, emojiLiftSv, insetLiftSv]);

  return {
    dockStickyStyle,
    emojiSlotStyle,
    jumpBtnBottomStyle,
    dockExtraPaddingSv,
    freezeListSv,
    listAnimatedRef,
    onListLayout,
    onListContentSizeChange,
    composeBaselinePx,
    emojiPanelHeightPx,
    onComposeShellLayout,
    onDockColumnIdleLayout,
    setDeleteBarHeightPx,
    recalibrateComposeBaseline,
    emojiPanelMounted,
    emojiAccessoryActive,
    keyboardOpen,
    composeDockActive: keyboardOpen || emojiPanelMounted,
    openEmoji,
    closeEmoji,
    showKeyboard,
    dismissKeyboard,
    resetDock,
  };
}
