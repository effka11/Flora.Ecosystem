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
 * влияет на ленту. Всё движение — только transform (никаких layout-анимаций,
 * которые отстают от transform на кадр и дают «клевки»):
 *  - translateY дока = ksvClosed - totalLift, totalLift = max(kbLift, emojiLift);
 *  - панель — absolute-слой фиксированной высоты (сиблинг дока, top:100%
 *    контейнера чата, z ниже) с тем же transform-ом: верх слоя всегда совпадает
 *    с нижней гранью дока, слой лэйаутится один раз при маунте и выезжает
 *    из-за нижней грани экрана вместе с подъёмом.
 * Позиция поля ввода = idle + totalLift. При переключении «клавиатура <->
 * эмодзи» totalLift константен по построению — поле и док не двигаются ни на
 * пиксель, клавиатура уезжает и открывает панель за собой (Telegram-паттерн).
 *
 * Лента. Клавиатурная механика KeyboardChatScrollView всегда заморожена
 * (freeze=true): её внутренний padding не растёт и она не скроллит. Весь
 * bottom-inset идёт одним shared value (extraContentPadding = navInset +
 * column + insetLift), где insetLift — «потолок» подъёма: расширяется до цели
 * в начале движения (чтобы worklet-scrollTo не клампился о старый диапазон)
 * и оседает к фактическому lift на осадке. Скролл докручивает единственный
 * worklet этого хука (whenAtEnd-семантика). Один писатель — нет гонок scrollTo.
 *
 * Плавность холодного открытия: React-коммиты не попадают в кадры анимации.
 * Порядок: коммит пустого слоя -> transform-полёт (UI-поток) -> осадка ->
 * emojiPanelReady=true (монтаж тяжёлого контента). Страховка — таймер
 * PANEL_OPEN_MS+120.
 *
 * Быстрые тапы: единая toggleEmoji решает по свежему ref; openEmoji всегда
 * гасит IME (в т.ч. поднимающуюся); показы IME в EMOJI_INTENT_GRACE_MS после
 * openEmoji считаются устаревшими и гасятся повторно; несостоявшийся показ
 * после showKeyboard добивают retry из onEnd(height=0) и JS-вотчдог — панель
 * при этом держит док (totalLift = max), ничего не проваливается в idle.
 */

const KB_HEIGHT_EPSILON_PX = 2;
const KB_PROGRESS_SETTLED = 0.999;
const PANEL_OPEN_MS = Platform.OS === "ios" ? 250 : 220;
const PANEL_CLOSE_MS = 200;
const PANEL_RELEASE_MS = 160;
const PANEL_EASING = ReanimatedEasing.out(ReanimatedEasing.cubic);
/**
 * Окно, в котором показ IME после openEmoji считается устаревшим (запрошен
 * ДО нажатия эмодзи) и повторно гасится вместо перехвата режима.
 */
const EMOJI_INTENT_GRACE_MS = 350;
/**
 * Окно повторного показа IME: если после showKeyboard клавиатура вместо
 * появления доехала до нуля (dismiss был в полёте и съел setFocusTo),
 * показываем её ещё раз, не роняя панель.
 */
const KB_SHOW_RETRY_WINDOW_MS = 900;
/**
 * Вотчдог показа IME: если после showKeyboard не пришло ВООБЩЕ никаких
 * keyboard-событий (show проглочен без встречного движения), повторяем показ
 * один раз. Обычный показ даёт willShow за <150 мс.
 */
const KB_SHOW_WATCHDOG_MS = 500;

export type ChatComposeDockConfig = {
  /** Нижний системный инсет (nav bar) — из resolveMessagesDockBottomInset. */
  systemNavBottomInsetPx: number;
};

export type ChatComposeDock = {
  /** translateY дока = ksvClosed - totalLift (док = absolute-оверлей снизу). */
  dockStickyStyle: AnimatedStyle<ViewStyle>;
  /**
   * translateY слоя панели (тот же, что у дока): слой — сиблинг дока с
   * top:100% контейнера чата, верхом всегда примыкает к нижней грани дока.
   */
  emojiPanelLayerStyle: AnimatedStyle<ViewStyle>;
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
  /** Фиксированная высота контента панели (слой top:100% под доком). */
  emojiPanelHeightPx: number;
  /**
   * true, когда док осел и тяжёлый контент панели (грид) можно монтировать:
   * React-коммит грида не должен попадать в кадры transform-анимации.
   */
  emojiPanelReady: boolean;
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
  /**
   * Единая кнопка «эмодзи/клавиатура»: решение по свежему ref, а не по
   * возможно устаревшему prop — быстрые тапы не двоят одно действие.
   */
  toggleEmoji: (showInput: () => void) => void;
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
  const [emojiPanelReady, setEmojiPanelReady] = useState(false);
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
  /** Отложенный старт холодного открытия: анимацию запускаем ПОСЛЕ коммита слоя. */
  const pendingColdOpenTargetRef = useRef<number | null>(null);
  /** Таймер страховки готовности контента панели. */
  const panelReadyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Момент openEmoji: показы IME старше этого окна — устаревшие, гасим повторно. */
  const emojiIntentAtRef = useRef(0);
  /** Момент showKeyboard (для retry показа IME); shared — читается в onEnd-воркалете. */
  const kbShowRequestAtSv = useSharedValue(0);
  /** Колбэк показа IME для retry из onEnd (после несостоявшегося setFocusTo). */
  const showInputRef = useRef<(() => void) | null>(null);
  /** Вотчдог показа IME (нет событий клавиатуры вообще). */
  const kbShowWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /**
   * Единственный движущийся стиль — transform. Панель приклеена под нижней
   * гранью дока (absolute top:100%, фиксированная высота), поэтому подъём по
   * totalLift одновременно поднимает поле и вывозит панель из-за нижней грани
   * экрана. Layout не анимируется вообще: нет покадрового Yoga-пересчёта и
   * рассинхрона transform/height (причина «клевков» при переключениях).
   */
  const dockStickyStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateY: ksvClosedPx - totalLiftSv.value }],
    }),
    [ksvClosedPx],
  );

  /**
   * Слой панели (absolute, top:100% контейнера чата = нижняя грань экрана)
   * едет тем же transform-ом, что и док: его верх всегда совпадает с нижней
   * гранью дока, контент уходит вниз за экран и выезжает вместе с подъёмом.
   */
  const emojiPanelLayerStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateY: ksvClosedPx - totalLiftSv.value }],
    }),
    [ksvClosedPx],
  );

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

  const clearPanelReadyTimer = useCallback(() => {
    if (panelReadyTimerRef.current) {
      clearTimeout(panelReadyTimerRef.current);
      panelReadyTimerRef.current = null;
    }
  }, []);

  /** Разрешить тяжёлый контент панели (док осел — коммит не попадёт в анимацию). */
  const markEmojiPanelReady = useCallback(() => {
    clearPanelReadyTimer();
    if (emojiPanelMountedRef.current) {
      setEmojiPanelReady(true);
    }
  }, [clearPanelReadyTimer]);

  const unmountEmojiPanel = useCallback(
    (reason: string) => {
      emojiPanelMountedRef.current = false;
      pendingColdOpenTargetRef.current = null;
      clearPanelReadyTimer();
      setEmojiPanelMounted(false);
      setEmojiPanelReady(false);
      if (__DEV__) {
        console.debug("[chat-compose-dock] unmount-panel", { reason });
      }
    },
    [clearPanelReadyTimer],
  );

  const currentKbLiftPx = useCallback(
    () => Math.max(0, -kbHeightSv.value - liftLossPx * kbProgressSv.value),
    [kbHeightSv, kbProgressSv, liftLossPx],
  );

  /** Страховка: контент монтируем после окна анимации, даже если completion
   * не пришёл (анимация была перехвачена/отменена). */
  const armPanelReadyFallback = useCallback(() => {
    clearPanelReadyTimer();
    panelReadyTimerRef.current = setTimeout(markEmojiPanelReady, PANEL_OPEN_MS + 120);
  }, [clearPanelReadyTimer, markEmojiPanelReady]);

  /** Холодный подъём панели: transform-анимация + осадка потолка inset. */
  const startColdOpenAnimation = useCallback(
    (target: number) => {
      followArmedSv.value = false;
      followSuppressedSv.value = false;
      cancelAnimation(emojiLiftSv);
      armPanelReadyFallback();
      emojiLiftSv.value = withTiming(
        target,
        { duration: PANEL_OPEN_MS, easing: PANEL_EASING },
        (finished) => {
          "worklet";
          if (finished) {
            insetLiftSv.value = totalLiftSv.value;
            runOnJS(markEmojiPanelReady)();
          }
        },
      );
    },
    [
      armPanelReadyFallback,
      emojiLiftSv,
      followArmedSv,
      followSuppressedSv,
      insetLiftSv,
      markEmojiPanelReady,
      totalLiftSv,
    ],
  );

  const openEmoji = useCallback(() => {
    if (emojiActiveRef.current) return;

    const kbLiftNow = currentKbLiftPx();
    const hot = kbLiftNow > KB_HEIGHT_EPSILON_PX;
    const kbSettled = kbProgressSv.value >= KB_PROGRESS_SETTLED;
    // Живой подъём точнее кеша: при переключении с осевшей клавиатуры панель
    // занимает ровно текущий подъём — totalLift не меняется, док стоит, IME
    // уезжает и открывает панель за собой. Если клавиатура ещё в полёте, берём
    // максимум с кешем, чтобы не зафиксировать половинную высоту.
    const target = hot
      ? kbSettled
        ? kbLiftNow
        : Math.max(kbLiftNow, resolveColdPanelHeightPx())
      : resolveColdPanelHeightPx();

    const wasMounted = emojiPanelMountedRef.current;
    emojiIntentAtRef.current = Date.now();
    kbShowRequestAtSv.value = 0;
    emojiActiveRef.current = true;
    emojiActiveSv.value = true;
    setEmojiAccessoryActive(true);
    mountEmojiPanel(target);

    cancelAnimation(emojiLiftSv);
    insetLiftSv.value = Math.max(insetLiftSv.value, target);

    // Гасим и уже открытую, и ещё поднимающуюся IME (быстрый тап после
    // запроса клавиатуры): панель — последнее намерение пользователя.
    // При закрытой клавиатуре вызов — безвредный no-op.
    void KeyboardController.dismiss({ keepFocus: true });

    if (hot) {
      // Якорь — максимум текущего подъёма панели и клавиатуры: при повторном
      // быстром тапе panel->kb->panel emojiLift ещё держит полную высоту, и
      // опускание якоря на kbLiftNow дало бы провал дока.
      const anchor = Math.max(emojiLiftSv.value, kbLiftNow);
      if (target > anchor + KB_HEIGHT_EPSILON_PX) {
        // Клавиатура ещё в полёте, а цель выше текущего подъёма: якорим и
        // доезжаем анимацией — totalLift непрерывен, без скачка.
        armPanelReadyFallback();
        emojiLiftSv.value = anchor;
        emojiLiftSv.value = withTiming(
          target,
          { duration: PANEL_OPEN_MS, easing: PANEL_EASING },
          (finished) => {
            "worklet";
            if (finished) {
              runOnJS(markEmojiPanelReady)();
            }
          },
        );
      } else {
        emojiLiftSv.value = Math.max(target, anchor);
        // Горячий свап: док неподвижен, наш transform не анимируется, IME
        // анимирует система в своём окне — коммит контента не срывает кадры.
        markEmojiPanelReady();
      }
      setKeyboardOpen(false);
    } else if (wasMounted) {
      // Слой уже в дереве (реопен во время закрытия) — коммита не будет,
      // стартуем сразу.
      startColdOpenAnimation(target);
    } else {
      // Холодное открытие: анимацию стартуем ПОСЛЕ коммита слоя (effect по
      // emojiPanelMounted), иначе React-коммит срывает первые кадры полёта.
      pendingColdOpenTargetRef.current = target;
    }

    if (__DEV__) {
      console.debug("[chat-compose-dock] open-emoji", { hot, kbSettled, target, wasMounted });
    }
  }, [
    armPanelReadyFallback,
    currentKbLiftPx,
    emojiActiveSv,
    emojiLiftSv,
    insetLiftSv,
    kbProgressSv,
    kbShowRequestAtSv,
    markEmojiPanelReady,
    mountEmojiPanel,
    resolveColdPanelHeightPx,
    startColdOpenAnimation,
  ]);

  /**
   * Старт холодной анимации строго после коммита слоя панели: пустой слой
   * (фон) уже в дереве, тяжёлый контент придержан emojiPanelReady — в кадрах
   * полёта нет ни одного React-коммита.
   */
  useEffect(() => {
    if (!emojiPanelMounted) return;
    const target = pendingColdOpenTargetRef.current;
    if (target === null) return;
    pendingColdOpenTargetRef.current = null;
    if (!emojiActiveRef.current) {
      // Пользователь успел перещёлкнуть на клавиатуру до коммита слоя —
      // подъём не нужен, пустой слой (lift=0, за краем экрана) убираем.
      unmountEmojiPanel("cold-open-abandoned");
      return;
    }
    startColdOpenAnimation(target);
  }, [emojiPanelMounted, startColdOpenAnimation, unmountEmojiPanel]);

  const closeEmoji = useCallback(() => {
    if (!emojiActiveRef.current && !emojiPanelMountedRef.current) return;

    emojiIntentAtRef.current = 0;
    kbShowRequestAtSv.value = 0;
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
          runOnJS(unmountEmojiPanel)("close");
        }
      },
    );
  }, [
    emojiActiveSv,
    emojiLiftSv,
    followArmedSv,
    followSuppressedSv,
    insetLiftSv,
    kbShowRequestAtSv,
    totalLiftSv,
    unmountEmojiPanel,
  ]);

  const showKeyboard = useCallback(
    (showInput: () => void) => {
      emojiIntentAtRef.current = 0;
      if (emojiActiveRef.current) {
        emojiActiveRef.current = false;
        emojiActiveSv.value = false;
        setEmojiAccessoryActive(false);
      }
      // Запоминаем запрос: если dismiss был в полёте и съел показ IME
      // (быстрый двойной тап), onEnd(height=0) повторит показ, не роняя панель.
      showInputRef.current = showInput;
      kbShowRequestAtSv.value = Date.now();
      // Панель остаётся смонтированной: клавиатура накрывает её (totalLift
      // держит max), остаток emojiLift отпускаем на onEnd клавиатуры.
      showInput();
      // Вотчдог: показ проглочен без каких-либо keyboard-событий (редкие
      // OEM-IME при dismiss в полёте) — один повтор. Любое реальное событие
      // клавиатуры обнуляет kbShowRequestAtSv, и вотчдог не срабатывает.
      if (kbShowWatchdogRef.current) clearTimeout(kbShowWatchdogRef.current);
      kbShowWatchdogRef.current = setTimeout(() => {
        kbShowWatchdogRef.current = null;
        if (emojiActiveRef.current) return;
        if (kbShowRequestAtSv.value <= 0) return;
        kbShowRequestAtSv.value = -1;
        if (__DEV__) {
          console.debug("[chat-compose-dock] kb-show-watchdog-retry");
        }
        showInput();
      }, KB_SHOW_WATCHDOG_MS);
    },
    [emojiActiveSv, kbShowRequestAtSv],
  );

  /**
   * Единая кнопка «эмодзи/клавиатура». Решение — по emojiActiveRef на момент
   * тапа, а не по prop-у рендера: при быстрой серии тапов каждый тап честно
   * инвертирует режим, двойной тап возвращает исходное состояние.
   */
  const toggleEmoji = useCallback(
    (showInput: () => void) => {
      if (emojiActiveRef.current) {
        showKeyboard(showInput);
      } else {
        openEmoji();
      }
    },
    [openEmoji, showKeyboard],
  );

  /** Retry показа IME из onEnd-воркалета (запрошенный показ не состоялся). */
  const retryShowKeyboard = useCallback(() => {
    if (emojiActiveRef.current) return;
    const showInput = showInputRef.current;
    if (!showInput) return;
    if (__DEV__) {
      console.debug("[chat-compose-dock] retry-show-keyboard");
    }
    showInput();
  }, []);

  const dismissKeyboard = useCallback(() => {
    kbShowRequestAtSv.value = 0;
    Keyboard.dismiss();
    setKeyboardOpen(false);
  }, [kbShowRequestAtSv]);

  /**
   * Клавиатура пошла вверх (кнопка, тап по инпуту, авто-фокус): переключаем
   * режим/иконку сразу; геометрию ведут воркалеты.
   */
  useEffect(() => {
    const onKeyboardShow = () => {
      if (emojiActiveRef.current) {
        // Показ, стартовавший до openEmoji (быстрый тап «клавиатура→эмодзи»):
        // не отдаём режим устаревшему событию — повторно гасим IME.
        if (Date.now() - emojiIntentAtRef.current < EMOJI_INTENT_GRACE_MS) {
          void KeyboardController.dismiss({ keepFocus: true });
          return;
        }
        emojiActiveRef.current = false;
        emojiActiveSv.value = false;
        setEmojiAccessoryActive(false);
      }
      kbShowRequestAtSv.value = 0;
      setKeyboardOpen(true);
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
  }, [emojiActiveSv, kbShowRequestAtSv]);

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

        const releasePanelRemainder = (reason: string) => {
          emojiLiftSv.value = withTiming(
            0,
            { duration: PANEL_RELEASE_MS, easing: PANEL_EASING },
            (finished) => {
              "worklet";
              if (finished) {
                insetLiftSv.value = totalLiftSv.value;
                runOnJS(unmountEmojiPanel)(reason);
              }
            },
          );
        };

        if (e.height <= KB_HEIGHT_EPSILON_PX) {
          // Клавиатура полностью ушла.
          if (!emojiActiveSv.value && emojiLiftSv.value > 0) {
            const requestedAt = kbShowRequestAtSv.value;
            if (requestedAt > 0 && Date.now() - requestedAt < KB_SHOW_RETRY_WINDOW_MS) {
              // Пользователь просил клавиатуру, а IME доехала до нуля: показ
              // съел параллельный dismiss (быстрый двойной тап). Панель НЕ
              // роняем — она держит док; показываем IME повторно. -1 = retry
              // использован, второй раз не пытаемся.
              kbShowRequestAtSv.value = -1;
              runOnJS(retryShowKeyboard)();
              return;
            }
            // Панель не целевой режим (back в середине перехода) — плавно
            // опускаем остаток, не даём «залипнуть».
            releasePanelRemainder("kb-hidden-release");
          } else {
            insetLiftSv.value = totalLiftSv.value;
          }
          return;
        }

        kbShowRequestAtSv.value = 0;
        runOnJS(commitCanonicalImeHeight)(e.height);
        if (emojiActiveSv.value || emojiLiftSv.value <= 0) {
          insetLiftSv.value = totalLiftSv.value;
          return;
        }
        // Клавиатура осела поверх панели: плавно отпустить остаток слота
        // (если новая клавиатура ниже панели) и размонтировать контент.
        releasePanelRemainder("kb-covered");
      },
    },
    [commitCanonicalImeHeight, liftLossPx, retryShowKeyboard, unmountEmojiPanel],
  );

  const resetDockInner = useCallback(() => {
    emojiActiveRef.current = false;
    emojiActiveSv.value = false;
    emojiIntentAtRef.current = 0;
    kbShowRequestAtSv.value = 0;
    showInputRef.current = null;
    if (kbShowWatchdogRef.current) {
      clearTimeout(kbShowWatchdogRef.current);
      kbShowWatchdogRef.current = null;
    }
    cancelAnimation(emojiLiftSv);
    emojiLiftSv.value = 0;
    insetLiftSv.value = 0;
    followArmedSv.value = false;
    followSuppressedSv.value = false;
    followBaseScrollSv.value = -1;
    unmountEmojiPanel("reset");
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
    kbShowRequestAtSv,
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
      if (panelReadyTimerRef.current) {
        clearTimeout(panelReadyTimerRef.current);
        panelReadyTimerRef.current = null;
      }
      if (kbShowWatchdogRef.current) {
        clearTimeout(kbShowWatchdogRef.current);
        kbShowWatchdogRef.current = null;
      }
    };
  }, [emojiActiveSv, emojiLiftSv, insetLiftSv]);

  return {
    dockStickyStyle,
    emojiPanelLayerStyle,
    jumpBtnBottomStyle,
    dockExtraPaddingSv,
    freezeListSv,
    listAnimatedRef,
    onListLayout,
    onListContentSizeChange,
    composeBaselinePx,
    emojiPanelHeightPx,
    emojiPanelReady,
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
    toggleEmoji,
    dismissKeyboard,
    resetDock,
  };
}
