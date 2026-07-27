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
  runOnUI,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
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
 * (freeze=true): её внутренний padding не растёт и она не скроллит.
 * dockExtraPaddingSv (navInset + baseline + deleteBar) несёт только статичную
 * геометрию дока и меняется редкими ступенями (замер дока, полоса ответа).
 * Всё движение ленты — transform (listLiftStyle): подъём (-totalLift) и рост
 * поля (-composeGrowth) на тех же shared values и в тех же кадрах, что у
 * dockStickyStyle, emojiPanelLayerStyle и самой pill. В инсет движение не
 * уходит принципиально: его смена — нативный коммит, который декоратор KCSV
 * гасит встречным scrollBy, а на якорь ленту возвращает отложенный на кадр
 * scrollTo — то есть заведомо не тот кадр, в котором едет док. Скролл
 * докручивает единственный worklet этого хука на изменениях самого инсета
 * (whenAtEnd-семантика). Один писатель — нет гонок scrollTo.
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
/** Проявление ленты после того, как тред расшифрован. */
const LIST_REVEAL_MS = 140;
/**
 * Пауза перед показом заглушки после перехода: короткое ожидание не должно
 * успевать мигнуть спиннером.
 */
const LIST_PLACEHOLDER_DELAY_MS = 120;

/**
 * Офсет последнего сообщения. Лента перевёрнута (`scaleY: -1` + обратный порядок
 * данных), поэтому последнее сообщение живёт в *начале* скролла, а не в конце, и
 * это главное свойство: ни высота контента, ни высота вьюпорта, ни предел
 * скролла сюда не входят — три величины, о которых JS узнаёт с опозданием,
 * больше не участвуют в определении низа.
 *
 * Платформы расходятся только в том, где лежит начало. На Android декоратор KCSV
 * эмулирует верхний inset сдвигом контента (`translationY`) и расширяет диапазон
 * через `paddingBottom`, поэтому начало — ноль. На iOS это настоящий
 * `contentInset.top`, и покой лежит на `-inset`; кламп тут не поможет, потому что
 * `setContentOffset` выход за диапазон не обрезает, а отрабатывает с отскоком.
 */
export function chatListAnchorOffset(dockPadPx: number): number {
  "worklet";
  return Platform.OS === "ios" ? -dockPadPx : 0;
}
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
  /** Подъём ленты: тот же totalLift, что у дока, только лента едет вверх. */
  listLiftStyle: AnimatedStyle<ViewStyle>;
  jumpBtnBottomStyle: AnimatedStyle<ViewStyle>;
  /**
   * Зазор ленты под доком в покое: navInset + baseline + deleteBar. У
   * перевёрнутой ленты KCSV кладёт его в `contentInset.top` — визуально это
   * всё равно низ. Ни подъём, ни рост поля сюда не входят: они transform-ом
   * (`listLiftStyle`), потому что каждая смена инсета — нативный коммит с
   * возвратом на якорь кадром позже.
   */
  dockExtraPaddingSv: SharedValue<number>;
  /** Библиотечную механику клавиатуры держим замороженной всегда. */
  freezeListSv: SharedValue<boolean>;
  /** Animated-ref внутреннего скролла ленты (для worklet-скролла). */
  listAnimatedRef: AnimatedRef<Reanimated.ScrollView>;
  /**
   * Вернуть ленту к последнему сообщению (началу скролла у перевёрнутой ленты)
   * и держать её там, пока пользователь не отмотает вверх.
   */
  pinListToBottom: (animated?: boolean) => void;
  /** Включить/снять прижатие без скролла — по жестам пользователя. */
  setListPinned: (pinned: boolean) => void;
  /** Прозрачность ленты: скрыта, пока тред не расшифрован. */
  listRevealStyle: AnimatedStyle<ViewStyle>;
  /** Обратная прозрачность — слой заглушки под лентой. */
  listPlaceholderStyle: AnimatedStyle<ViewStyle>;
  /** Спрятать ленту до следующего показа — на смене треда. */
  hideListUntilReady: () => void;
  /** Разрешить показ: тред расшифрован, высоты больше не поедут. */
  allowListReveal: () => void;
  /** Переход в чат доигран — заглушке можно появляться, лента может ехать. */
  finishEnterTransition: () => void;
  composeBaselinePx: number;
  /** Фиксированная высота контента панели (слой top:100% под доком). */
  emojiPanelHeightPx: number;
  /**
   * true, когда док осел и тяжёлый контент панели (грид) можно монтировать:
   * React-коммит грида не должен попадать в кадры transform-анимации.
   */
  emojiPanelReady: boolean;
  /** Высота оболочки поля: измерение покоя либо цель роста на новую строку. */
  onComposeShellLayout: (height: number) => void;
  /**
   * Остаток хода до ступени зазора. Пишет поле (ChatComposeField) — у роста
   * pill и у догона ленты обязана быть одна кривая и один кадр.
   */
  composeGrowthHoldSv: SharedValue<number>;
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
  /** Рост оболочки поля над однострочником: строки, полоса картинок. Ступень. */
  const composeGrowthSv = useSharedValue(0);
  /**
   * Сколько полю осталось добрать до ступени: ступень применяется сразу, а
   * видимый рост доезжает кривой. Величину ведёт ChatComposeField — это ровно
   * недобранная высота pill, поэтому верхняя грань поля и низ ленты не могут
   * разъехаться ни на кадр, ни на пиксель.
   */
  const composeGrowthHoldSv = useSharedValue(0);
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

  /**
   * Рост поля, каким его видно прямо сейчас: ступень минус то, что полю ещё
   * осталось добрать. В кадре ступени это ровно прежняя высота, дальше —
   * кривая самого поля.
   */
  const liveComposeGrowthSv = useDerivedValue(
    () => composeGrowthSv.value - composeGrowthHoldSv.value,
  );

  /**
   * Движение ленты — подъём дока и рост поля, оба transform-ом и оба на тех же
   * shared values, что и сам док. Рост принципиально не уходит в инсет: смена
   * инсета — это нативный коммит с встречным scrollBy декоратора и возвратом
   * на якорь кадром позже, то есть заведомо не тот кадр, в котором едет pill.
   * Лента дёргалась именно на этом расхождении.
   */
  const listLiftStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -(totalLiftSv.value + liveComposeGrowthSv.value) },
    ],
  }));

  useAnimatedReaction(
    () => ({
      deleteBar: deleteBarHeightSv.value,
      baseline: composeBaselineSv.value,
    }),
    (cur) => {
      dockExtraPaddingSv.value = dockIdleGapPx + cur.baseline + cur.deleteBar;
    },
    [dockIdleGapPx],
  );

  /** Кнопка «новые сообщения» ездит за подъёмом дока. */
  const jumpBtnBottomStyle = useAnimatedStyle(
    () => ({
      bottom:
        dockIdleGapPx +
        composeBaselineSv.value +
        liveComposeGrowthSv.value +
        deleteBarHeightSv.value +
        totalLiftSv.value +
        floraSpacing.grid,
    }),
    [dockIdleGapPx],
  );

  // --- Единственный писатель скролла ленты ---

  const pinToBottomSv = useSharedValue(true);

  /**
   * Зазор под доком уезжает в `contentInset` KCSV, и при его изменении нативный
   * декоратор доскролливает на дельту, чтобы контент визуально стоял на месте.
   * Посреди истории это верно, а у последнего сообщения — нет: там лента должна
   * ехать вместе с доком, иначе свежая строка уходит под поле ввода. Поэтому у
   * якоря мы перекрываем нативную компенсацию возвратом в начало.
   *
   * Скролл отложен на кадр — как в `useExtraContentPadding` библиотеки: на этом
   * кадре нативный диапазон ещё старый, и цель склампилась бы в ту самую
   * недостачу, которую возврат и лечит.
   *
   * Рост поля сюда не приходит вовсе (он transform-ом, см. listLiftStyle) —
   * остаются редкие ступени: замер дока и полоса ответа.
   */
  useAnimatedReaction(
    () => dockExtraPaddingSv.value,
    (cur, prev) => {
      if (prev === null || cur === prev) return;
      if (!pinToBottomSv.value) return;
      requestAnimationFrame(() => {
        if (!pinToBottomSv.value) return;
        scrollTo(listAnimatedRef, 0, chatListAnchorOffset(cur), false);
      });
    },
    [],
  );

  /**
   * Лента невидима, пока тред не готов. Позиция теперь верна с первого кадра,
   * но высоты строк до расшифровки чужие: текст приходит волнами, и каждая
   * перекладывает пузыри. Прозрачность прячет эту осадку, а не низ.
   */
  const listRevealSv = useSharedValue(0);
  const listRevealStartedSv = useSharedValue(false);

  /**
   * Пока идёт переход в чат, внутри экрана не должно меняться ничего: он и так
   * проявляется целиком (`animation: "fade"`), и любое движение внутри читается
   * как мигание. Заглушка поэтому ждёт конца перехода, а не показывается сразу.
   */
  const enterRunningSv = useSharedValue(true);
  const listPlaceholderSv = useSharedValue(0);

  const listRevealStyle = useAnimatedStyle(() => ({
    opacity: listRevealSv.value,
  }));

  const listPlaceholderStyle = useAnimatedStyle(() => ({
    opacity: listPlaceholderSv.value,
  }));

  const pinListToBottom = useCallback(
    (animated = false) => {
      pinToBottomSv.value = true;
      runOnUI(() => {
        scrollTo(
          listAnimatedRef,
          0,
          chatListAnchorOffset(dockExtraPaddingSv.value),
          animated,
        );
      })();
    },
    [dockExtraPaddingSv, listAnimatedRef, pinToBottomSv],
  );

  const setListPinned = useCallback(
    (pinned: boolean) => {
      // Невидимую ленту распинать нечему: жест по нулевой прозрачности снял бы
      // прижатие, и она осталась бы скрытой навсегда.
      if (!pinned && !listRevealStartedSv.value) return;
      pinToBottomSv.value = pinned;
    },
    [listRevealStartedSv, pinToBottomSv],
  );

  /**
   * Спрятать ленту до готовности нового треда: ячейки пересоздаются, а
   * прозрачность живёт в доке и осталась бы от прежнего треда.
   */
  const hideListUntilReady = useCallback(() => {
    cancelAnimation(listRevealSv);
    cancelAnimation(listPlaceholderSv);
    listRevealStartedSv.value = false;
    listRevealSv.value = 0;
    listPlaceholderSv.value = 0;
    enterRunningSv.value = true;
  }, [enterRunningSv, listPlaceholderSv, listRevealSv, listRevealStartedSv]);

  /**
   * Переход в чат закончился. Если лента ещё не готова — только теперь имеет
   * смысл заглушка, и то с паузой: ожидание в сотню миллисекунд не должно
   * успевать мигнуть спиннером.
   */
  const finishEnterTransition = useCallback(() => {
    enterRunningSv.value = false;
    if (listRevealStartedSv.value) return;
    cancelAnimation(listPlaceholderSv);
    listPlaceholderSv.value = withDelay(
      LIST_PLACEHOLDER_DELAY_MS,
      withTiming(1, { duration: LIST_REVEAL_MS, easing: PANEL_EASING }),
    );
  }, [enterRunningSv, listPlaceholderSv, listRevealStartedSv]);

  /**
   * Тред готов — показываем. Ждать события о размере контента больше не нужно:
   * у перевёрнутой ленты последнее сообщение стоит в начале скролла с первого
   * кадра, поэтому проявлять можно сразу, не зная ни высоты контента, ни того,
   * домерила ли FlashList строки.
   */
  const allowListReveal = useCallback(() => {
    if (listRevealStartedSv.value) return;
    listRevealStartedSv.value = true;
    runOnUI(() => {
      // Кадр отсрочки: разрешение приходит из коммита реакта, а зазор дока в
      // этот момент ещё применяется нативно — и его смена тянет за собой
      // компенсирующий `scrollBy` декоратора KCSV. Показать сейчас значит
      // показать ровно перед этим сдвигом.
      requestAnimationFrame(() => {
        // Скролл и прозрачность — в одном кадре: первый видимый кадр обязан
        // быть на якоре. На Android якорь ноль, то есть мы уже там, а на iOS
        // покой лежит на `-contentInset.top`, и сам инсет офсет не двигает
        // (`contentInsetAdjustmentBehavior="never"`) — занимаем явно.
        if (pinToBottomSv.value) {
          scrollTo(
            listAnimatedRef,
            0,
            chatListAnchorOffset(dockExtraPaddingSv.value),
            false,
          );
        }
        cancelAnimation(listRevealSv);
        cancelAnimation(listPlaceholderSv);
        // Внутри перехода экран проявляется целиком (`animation: "fade"`) —
        // своя анимация читалась бы вторым, лишним движением.
        listRevealSv.value = enterRunningSv.value
          ? 1
          : withTiming(1, { duration: LIST_REVEAL_MS, easing: PANEL_EASING });
        listPlaceholderSv.value =
          listPlaceholderSv.value > 0
            ? withTiming(0, { duration: LIST_REVEAL_MS, easing: PANEL_EASING })
            : 0;
      });
    })();
  }, [
    dockExtraPaddingSv,
    enterRunningSv,
    listAnimatedRef,
    listPlaceholderSv,
    listRevealSv,
    listRevealStartedSv,
    pinToBottomSv,
  ]);

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
    // Догонять нечего: геометрия пересобирается заново, лента должна стоять
    // ровно на новом зазоре, а не доезжать до старой цели.
    cancelAnimation(composeGrowthHoldSv);
    composeGrowthHoldSv.value = 0;
  }, [composeBaselineSv, composeGrowthHoldSv, composeGrowthSv]);

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

  /** Холодный подъём панели: transform-анимация до целевого lift. */
  const startColdOpenAnimation = useCallback(
    (target: number) => {
      cancelAnimation(emojiLiftSv);
      armPanelReadyFallback();
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
    },
    [armPanelReadyFallback, emojiLiftSv, markEmojiPanelReady],
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

    cancelAnimation(emojiLiftSv);
    emojiLiftSv.value = withTiming(
      0,
      { duration: PANEL_CLOSE_MS, easing: PANEL_EASING },
      (finished) => {
        "worklet";
        if (finished) {
          runOnJS(unmountEmojiPanel)("close");
        }
      },
    );
  }, [emojiActiveSv, emojiLiftSv, kbShowRequestAtSv, unmountEmojiPanel]);

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
      onInteractive: () => {
        "worklet";
        // Свайп-дисмисс: лентой владеет палец, возврат к якорю тут не наш.
        pinToBottomSv.value = false;
      },
      onEnd: (e) => {
        "worklet";

        const releasePanelRemainder = (reason: string) => {
          emojiLiftSv.value = withTiming(
            0,
            { duration: PANEL_RELEASE_MS, easing: PANEL_EASING },
            (finished) => {
              "worklet";
              if (finished) {
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
          }
          return;
        }

        kbShowRequestAtSv.value = 0;
        runOnJS(commitCanonicalImeHeight)(e.height);
        if (emojiActiveSv.value || emojiLiftSv.value <= 0) {
          return;
        }
        // Клавиатура осела поверх панели: плавно отпустить остаток слота
        // (если новая клавиатура ниже панели) и размонтировать контент.
        releasePanelRemainder("kb-covered");
      },
    },
    [commitCanonicalImeHeight, retryShowKeyboard, unmountEmojiPanel],
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
    pinToBottomSv.value = true;
    unmountEmojiPanel("reset");
    setEmojiAccessoryActive(false);
    setKeyboardOpen(false);
    composeGrowthSv.value = 0;
    cancelAnimation(composeGrowthHoldSv);
    composeGrowthHoldSv.value = 0;
    deleteBarHeightSv.value = 0;
    composeBaselineRef.current = 0;
    composeBaselineSv.value = COMPOSE_BASELINE_FALLBACK_PX;
    setComposeBaselinePx(0);
    Keyboard.dismiss();
  }, [
    composeBaselineSv,
    composeGrowthHoldSv,
    composeGrowthSv,
    deleteBarHeightSv,
    emojiActiveSv,
    emojiLiftSv,
    kbShowRequestAtSv,
    pinToBottomSv,
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
  }, [emojiActiveSv, emojiLiftSv]);

  return {
    dockStickyStyle,
    emojiPanelLayerStyle,
    listLiftStyle,
    jumpBtnBottomStyle,
    dockExtraPaddingSv,
    freezeListSv,
    listAnimatedRef,
    pinListToBottom,
    setListPinned,
    listRevealStyle,
    listPlaceholderStyle,
    hideListUntilReady,
    allowListReveal,
    finishEnterTransition,
    composeBaselinePx,
    emojiPanelHeightPx,
    emojiPanelReady,
    onComposeShellLayout,
    composeGrowthHoldSv,
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
