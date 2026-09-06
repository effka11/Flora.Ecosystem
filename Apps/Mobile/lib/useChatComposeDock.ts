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
  useScrollOffset,
  useSharedValue,
  withDelay,
  withTiming,
  type AnimatedRef,
  type AnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { ENERGETIC_OPEN_EASING } from "@/lib/energeticSettle";
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
import { mmkv } from "@/lib/mmkv";
import { floraMotion, floraSpacing } from "@/lib/theme";
import { shouldSkipFloraMotion, useFloraReduceMotion } from "@/lib/useFloraReduceMotion";

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
/**
 * Пауза перед показом заглушки: короткое ожидание не должно успевать
 * мигнуть спиннером на тёплом кэше.
 */
const LIST_PLACEHOLDER_DELAY_MS = 120;
/**
 * Кадры тишины лэйаута ленты перед показом. `onLoad` означает «видимые строки
 * замерены», но коррекции оценочных высот и хвостовые коммиты FlashList может
 * применить кадром-двумя позже — показ до них выглядит как «пузыри
 * допрыгивают на место». Тишина = столько кадров подряд без
 * onContentSizeChange.
 */
const LIST_LAYOUT_QUIET_FRAMES = 3;
/**
 * Последний замер baseline дока (высота compose-колонки в покое). Док один и
 * тот же во всех чатах — сид следующего открытия убирает ступень
 * fallback→замер (коммит + сдвиг listGapPx) и снимает гейт composeBaselinePx>0
 * ещё до onLayout. Персистится в MMKV: без этого ПЕРВОЕ открытие после
 * рестарта стартовало с fallback и после замера сдвигало paddingTop ленты
 * (в трассе: content-size +7px сразу после reveal). Смена font-scale/шрифта
 * перезапускает приложение, а расхождение чинит первый же onLayout.
 */
const COMPOSE_BASELINE_MMKV_KEY = "chat.composeBaselinePx";
let lastMeasuredComposeBaselinePx = mmkv.getNumber(COMPOSE_BASELINE_MMKV_KEY) ?? 0;

/** Окно дев-трассировки осадки после reveal. */
const SETTLE_TRACE_WINDOW_MS = 2000;
/** Потолок строк лога осадки на один показ (не заспамить консоль анимацией). */
const SETTLE_TRACE_MAX_LOGS = 12;

/**
 * Офсет последнего сообщения. Лента перевёрнута (`scaleY: -1` + обратный порядок
 * данных), поэтому последнее сообщение живёт в *начале* скролла, а не в конце, и
 * это главное свойство: ни высота контента, ни высота вьюпорта, ни предел
 * скролла сюда не входят — три величины, о которых JS узнаёт с опозданием,
 * больше не участвуют в определении низа.
 *
 * Зазор дока — `paddingTop` контент-контейнера ленты (React-проп, см.
 * listGapPx), а не contentInset KCSV: инсет жил в animatedProps, и React-коммиты
 * FlashList затирали его нативное значение дефолтом до следующего пересчёта —
 * лента вставала вплотную к доку ровно до первого «пинка» (видимый прыжок на
 * величину зазора в кадре показа). Padding — часть ShadowTree, коммиты его
 * не теряют. Начало скролла при этом — ноль на обеих платформах.
 */
export function chatListAnchorOffset(): number {
  "worklet";
  return 0;
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

/**
 * Проявление ленты в кадре, где экран ещё едет (push чата не сел): движение
 * само маскирует появление контента, поэтому фейд короткий — на шаге сетки
 * Flora — и успевает закончиться до посадки. Лента приходит вместе со сценой,
 * а не «догружается» после неё.
 */
const REVEAL_COVER_FADE_IN_MOTION_MS = floraMotion.baseMs;
/**
 * Проявление на уже стоящей сцене (тяжёлый тред домерялся дольше слайда):
 * маскировать нечем, поэтому мягче — но вдвое короче прежних baseMs*3, где
 * заметно читалось «пустой чат, потом контент».
 */
const REVEAL_COVER_FADE_MS = floraMotion.baseMs * 2;

function revealCoverFadeMs(enterMotionProgress: number): number {
  "worklet";
  return enterMotionProgress < 1 ? REVEAL_COVER_FADE_IN_MOTION_MS : REVEAL_COVER_FADE_MS;
}

export type ChatComposeDockConfig = {
  /** Нижний системный инсет (nav bar) — из resolveMessagesDockBottomInset. */
  systemNavBottomInsetPx: number;
  /**
   * Прогресс входной анимации экрана: <1 — сцена ещё едет, 1 — стоит. Нужен
   * только темпу проявления ленты (см. revealCoverFadeMs); без него док
   * считает, что сцена на месте.
   */
  enterMotionSv?: SharedValue<number>;
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
   * Зазор ленты под доком в покое: navInset + baseline + deleteBar — SV для
   * дев-трассировки и worklet-геометрии. В KCSV НЕ уходит: нативную позицию
   * ленты несёт listGapPx (React-padding), см. комментарий у него.
   */
  dockExtraPaddingSv: SharedValue<number>;
  /**
   * Зазор ленты под доком как число для `contentContainerStyle.paddingTop`
   * перевёрнутой ленты (в flip-пространстве top = визуальный низ). Именно
   * React-padding, а не inset KCSV: inset жил в animatedProps, React-коммиты
   * FlashList затирали его нативное значение, и лента вставала вплотную к
   * доку до следующего пересчёта — «прыжок пузырей» ровно на величину зазора
   * в кадре показа. Padding — часть ShadowTree, его коммиты не теряют.
   * Подъём и рост поля сюда не входят: они transform-ом (`listLiftStyle`).
   */
  listGapPx: number;
  /**
   * Ноль для extraContentPadding KCSV: весь статичный зазор — в listGapPx,
   * инсет-эмуляция декоратора не участвует вовсе.
   */
  listInsetZeroSv: SharedValue<number>;
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
  /** Обратная прозрачность — слой заглушки под лентой. */
  listPlaceholderStyle: AnimatedStyle<ViewStyle>;
  /**
   * Enter-ковёр области ленты: непрозрачный фон поверх ленты до первого
   * собранного кадра; на reveal гаснет Flora-фейдом (flora ease-out,
   * задержка-кадр, темп по revealCoverFadeMs) — сцена «проявляется», а не
   * вспыхивает.
   * Ковёр, а не opacity самой ленты: её видимость обязана остаться
   * React-коммитом (см. listPlaceholderStyle), а оверлей с UI-анимацией —
   * проверенный паттерн TabRouteTransition.
   */
  listEnterCoverStyle: AnimatedStyle<ViewStyle>;
  /** Спрятать ленту до следующего показа — на смене треда. */
  hideListUntilReady: () => void;
  /** Разрешить показ: тред расшифрован, высоты больше не поедут. */
  allowListReveal: () => void;
  /**
   * Сколько кадров тишины лэйаута ждать перед показом (1..дефолт). Экран
   * снижает до 1, когда всё окно показа прогрето и коррекций высот не будет.
   */
  setListRevealQuietFrames: (frames: number) => void;
  /**
   * Гейт финальной раскладки текста окна показа: false — показ ждёт, пока
   * замеры тел лягут в кэш (экран следит и снимает; потолок — на экране).
   */
  setListTextLayoutReady: (ready: boolean) => void;
  /**
   * Тёплый быстрый путь: показать ленту в текущем JS-коммите, минуя UI-гейты.
   * Звать из onLoad, когда все замеры текста окна показа уже в кэше.
   */
  revealListNow: () => void;
  /** onLoad FlashList: каждая видимая строка замерена — раскладка финальна. */
  onListLoad: () => void;
  /**
   * onContentSizeChange FlashList: обнуляет «тишину лэйаута» — показ ленты
   * ждёт нескольких кадров подряд без изменений размера контента.
   */
  onListContentSizeChange: (w: number, h: number) => void;
  /** Лента показана (reveal состоялся): пора запускать тихий пост-догруз. */
  listRevealed: boolean;
  /** Стек на экране — заглушке можно появляться, если лента ещё скрыта. */
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

  const [composeBaselinePx, setComposeBaselinePx] = useState(
    () => lastMeasuredComposeBaselinePx,
  );
  /** JS-зеркало высоты delete-бара — участвует в listGapPx (React-padding). */
  const [deleteBarHeightPx, setDeleteBarHeightState] = useState(0);
  const [emojiPanelMounted, setEmojiPanelMounted] = useState(false);
  const [emojiPanelHeightPx, setEmojiPanelHeightPx] = useState(0);
  const [emojiPanelReady, setEmojiPanelReady] = useState(false);
  const [emojiAccessoryActive, setEmojiAccessoryActive] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  /**
   * Зазор ленты под доком как React-padding (см. док-комментарий в типе).
   * До замера дока — fallback: padding обязан существовать с первого кадра,
   * ступень fallback→замер коммитится до показа (гейт composeBaselinePx > 0).
   */
  const listGapPx =
    dockIdleGapPx +
    (composeBaselinePx > 0 ? composeBaselinePx : COMPOSE_BASELINE_FALLBACK_PX()) +
    deleteBarHeightPx;

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
    dockIdleGapPx + (lastMeasuredComposeBaselinePx || COMPOSE_BASELINE_FALLBACK_PX()),
  );
  const composeBaselineSv = useSharedValue(
    lastMeasuredComposeBaselinePx || COMPOSE_BASELINE_FALLBACK_PX(),
  );
  /** Всегда 0 — extraContentPadding KCSV выведен из игры (см. listGapPx). */
  const listInsetZeroSv = useSharedValue(0);
  const freezeListSv = useSharedValue(true);
  /** true = панель — целевой режим (иконка «клавиатура», IME не запрошен). */
  const emojiActiveSv = useSharedValue(false);

  const emojiActiveRef = useRef(false);
  const emojiPanelMountedRef = useRef(false);
  const composeBaselineRef = useRef(lastMeasuredComposeBaselinePx);
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
   * Фактический офсет скролла ленты (с нативных scroll-событий). Нужен показу:
   * «я отправил scrollTo» не значит «лента на якоре» — компенсирующий scrollBy
   * декоратора инсета KCSV может приземлиться ПОЗЖЕ и сбить якорь. Показ
   * верифицирует офсет, а не верит команде.
   */
  const listScrollOffsetSv = useScrollOffset(listAnimatedRef);

  // Компенсационной реакции на смену зазора больше нет: зазор — React-padding
  // контент-контейнера (listGapPx). У якоря (офсет 0) смена padding сама сдвигает
  // контент вместе с доком без скролла; нативный инсет-декоратор не участвует.

  /**
   * Лента невидима, пока тред не готов. Позиция теперь верна с первого кадра,
   * но высоты строк до расшифровки чужие: текст приходит волнами, и каждая
   * перекладывает пузыри. Прозрачность прячет эту осадку, а не низ.
   */
  const listRevealSv = useSharedValue(0);
  const listRevealStartedSv = useSharedValue(false);

  /**
   * FlashList v2 монтирует видимые строки прогрессивными волнами и зовёт
   * onLoad, когда каждая видимая строка получила замер. До этого проявляться
   * нельзя: часть пузырей ещё не смонтирована, и они «доезжали» бы на глазах.
   */
  const listLoadedSv = useSharedValue(false);

  /**
   * Заглушка под лентой. Показ — мгновенный (без кроссфейда с лентой);
   * на тёплом кэше тред готов в том же кадре, и спиннер не должен вспыхнуть.
   */
  const listPlaceholderSv = useSharedValue(0);

  /**
   * Enter-ковёр области ленты (см. тип). 1 = непрозрачный фон (до показа),
   * 0 = лента открыта. Reveal стартует фейд 1→0; смена треда возвращает 1.
   */
  const listEnterCoverSv = useSharedValue(1);
  /** Сцена «стоит» — дефолт для экранов без входной анимации (deep link). */
  const ownEnterMotionSv = useSharedValue(1);
  const enterMotionSv = config.enterMotionSv ?? ownEnterMotionSv;
  /** Reduce motion для UI-worklet'а показа: фейд заменяется мгновенным 0. */
  const skipMotionSv = useSharedValue(false);
  const reduceMotion = useFloraReduceMotion();
  useEffect(() => {
    skipMotionSv.value = shouldSkipFloraMotion(reduceMotion);
  }, [reduceMotion, skipMotionSv]);
  const listEnterCoverStyle = useAnimatedStyle(() => ({
    opacity: listEnterCoverSv.value,
  }));

  /**
   * JS-зеркало состоявшегося reveal: тяжёлую пост-работу (тихий сетевой
   * догруз треда) экран запускает только ПОСЛЕ первого видимого кадра ленты,
   * чтобы merge и ре-рендеры не крали кадры у открытия.
   */
  const [listRevealed, setListRevealed] = useState(false);

  /** Кадры подряд без onContentSizeChange ленты (см. LIST_LAYOUT_QUIET_FRAMES). */
  const listLayoutQuietSv = useSharedValue(0);
  /**
   * Сколько кадров тишины требуется этому показу. По умолчанию консервативные
   * LIST_LAYOUT_QUIET_FRAMES; экран снижает до 1, когда всё окно показа
   * прогрето (замеры текста в кэше — коррекций высот не будет): −2 кадра
   * до первого видимого кадра.
   */
  const listQuietFramesSv = useSharedValue(LIST_LAYOUT_QUIET_FRAMES);

  const setListRevealQuietFrames = useCallback(
    (frames: number) => {
      listQuietFramesSv.value = Math.max(
        1,
        Math.min(LIST_LAYOUT_QUIET_FRAMES, Math.round(frames)),
      );
    },
    [listQuietFramesSv],
  );

  /**
   * Гейт финальной раскладки текста: false, пока замеры тел окна показа не в
   * кэше (экран следит и снимает). Без него показ успевал раньше, чем
   * закончатся двухпроходные замеры в ячейках, и пузыри доизмерялись уже на
   * экране — «элементы появляются не сразу». Экран страхует потолком ожидания.
   */
  const listTextReadySv = useSharedValue(true);

  const setListTextLayoutReady = useCallback(
    (ready: boolean) => {
      listTextReadySv.value = ready;
    },
    [listTextReadySv],
  );
  /** Момент reveal на UI-потоке — окно дев-трассировки осадки. */
  const revealAtSv = useSharedValue(0);
  /** Остаток лог-бюджета трассировки осадки текущего показа. */
  const settleLogBudgetSv = useSharedValue(0);
  /** JS-зеркало окна осадки (для логов из JS-колбэков). */
  const revealSettleUntilRef = useRef(0);
  const lastContentHeightRef = useRef(0);

  const markRevealed = useCallback(() => {
    revealSettleUntilRef.current = Date.now() + SETTLE_TRACE_WINDOW_MS;
    setListRevealed(true);
  }, []);

  /**
   * Любое изменение размера контента ленты обнуляет тишину лэйаута: волна
   * монтажа строк, коррекция оценочной высоты, поздний коммит. В окне осадки
   * после показа изменение размера — уже симптом (двигает пузыри) — логируем.
   */
  const onListContentSizeChange = useCallback(
    (_w: number, h: number) => {
      listLayoutQuietSv.value = 0;
      if (!__DEV__) return;
      const prevH = lastContentHeightRef.current;
      lastContentHeightRef.current = h;
      const until = revealSettleUntilRef.current;
      if (until > 0 && Date.now() < until && prevH !== h) {
        console.log(
          `[chat-settle] content-size ${Math.round(prevH)}→${Math.round(h)} ` +
            `(+${Math.round(Date.now() - (until - SETTLE_TRACE_WINDOW_MS))}мс после reveal)`,
        );
      }
    },
    [listLayoutQuietSv],
  );

  /**
   * Видимость самой ленты — НЕ animated style, а React-состояние listRevealed
   * (см. экран треда): анимированный opacity, поставленный с UI-потока,
   * терялся на следующем React-коммите (Fabric возвращал запечённый начальный
   * opacity:0 из useAnimatedStyle) — лента гасла через кадр после показа.
   * listRevealSv остаётся внутренним сигналом цикла показа.
   */
  const listPlaceholderStyle = useAnimatedStyle(() => ({
    opacity: listPlaceholderSv.value,
  }));

  const pinListToBottom = useCallback(
    (animated = false) => {
      pinToBottomSv.value = true;
      runOnUI(() => {
        scrollTo(listAnimatedRef, 0, chatListAnchorOffset(), animated);
      })();
    },
    [listAnimatedRef, pinToBottomSv],
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
    if (__DEV__ && listRevealStartedSv.value) {
      // Смок-сигнал «мигания»: hide прервал уже запущенный (или показанный)
      // цикл показа. Легитимно только на реальной смене треда.
      console.log(
        `[chat-open] hide после старта показа (reveal=${listRevealSv.value})`,
      );
    }
    cancelAnimation(listRevealSv);
    cancelAnimation(listPlaceholderSv);
    cancelAnimation(listEnterCoverSv);
    listRevealStartedSv.value = false;
    listRevealSv.value = 0;
    listPlaceholderSv.value = 0;
    // Ковёр снова непрозрачен: новый тред собирается под ним.
    listEnterCoverSv.value = 1;
    listLoadedSv.value = false;
    listLayoutQuietSv.value = 0;
    listQuietFramesSv.value = LIST_LAYOUT_QUIET_FRAMES;
    listTextReadySv.value = true;
    revealAtSv.value = 0;
    settleLogBudgetSv.value = 0;
    revealSettleUntilRef.current = 0;
    lastContentHeightRef.current = 0;
    setListRevealed(false);
  }, [
    listEnterCoverSv,
    listLayoutQuietSv,
    listLoadedSv,
    listPlaceholderSv,
    listQuietFramesSv,
    listRevealSv,
    listRevealStartedSv,
    listTextReadySv,
    revealAtSv,
    settleLogBudgetSv,
  ]);

  const onListLoad = useCallback(() => {
    listLoadedSv.value = true;
  }, [listLoadedSv]);

  /**
   * Стек уже на экране. Если лента ещё не готова — заглушка после паузы,
   * без fade: opacity 0→1 в одном кадре.
   */
  const finishEnterTransition = useCallback(() => {
    if (listRevealStartedSv.value) return;
    cancelAnimation(listPlaceholderSv);
    listPlaceholderSv.value = withDelay(
      LIST_PLACEHOLDER_DELAY_MS,
      withTiming(1, { duration: 0 }),
    );
  }, [listPlaceholderSv, listRevealStartedSv]);

  /**
   * Тред готов — показываем, но только когда финальна вся видимая картинка:
   *
   *   1. FlashList доложил onLoad — каждая видимая строка смонтирована и
   *      замерена (v2 рисует их волнами, до onLoad часть пузырей отсутствует);
   *   2. лэйаут ленты затих — несколько кадров подряд без onContentSizeChange
   *      (сюда же попадает коммит ступени padding fallback→замер дока).
   *
   * Затем ВЕРИФИЦИРУЕМ якорь по фактическому офсету (listScrollOffsetSv):
   * «scrollTo отправлен» ≠ «лента на якоре». Показ — только после двух кадров
   * подряд ровно на якоре; любой снос до показа ловится и перезаякоривается
   * невидимо. Потолок ожидания — страховка от зависших случаев.
   */
  const allowListReveal = useCallback(() => {
    if (listRevealStartedSv.value) return;
    listRevealStartedSv.value = true;
    // Показ решён — отложенный спиннер (finishEnterTransition) больше не
    // нужен: не даём ему вспыхнуть, пока FlashList домеряет строки.
    cancelAnimation(listPlaceholderSv);
    runOnUI(() => {
      let framesLeft = 60;
      // Кадры подряд, в которые офсет фактически замерен на якоре (Android),
      // либо кадры с момента посадки (iOS — см. ветку ниже).
      let anchoredFrames = 0;
      const reveal = () => {
        cancelAnimation(listRevealSv);
        cancelAnimation(listPlaceholderSv);
        // Якорь верифицирован кадрами раньше. Пиксели показывает НЕ этот SV,
        // а коммит markRevealed → listRevealed=true (экран треда): обычный
        // закоммиченный opacity стабилен к последующим коммитам Fabric,
        // в отличие от animated style с UI-потока. Лента появляется и
        // заглушка гаснет в одном и том же коммите — атомарно.
        listRevealSv.value = 1;
        revealAtSv.value = Date.now();
        settleLogBudgetSv.value = SETTLE_TRACE_MAX_LOGS;
        listPlaceholderSv.value = 0;
        // Сцена готова под ковром — Flora-фейд входа (задержка-кадр + flora
        // ease-out; темп по revealCoverFadeMs: под едущим слайдом короче).
        // Лента при этом уже видима (listRevealed) — проявление делает ковёр.
        cancelAnimation(listEnterCoverSv);
        if (skipMotionSv.value) {
          listEnterCoverSv.value = 0;
        } else {
          listEnterCoverSv.value = 1;
          listEnterCoverSv.value = withDelay(
            floraMotion.tabTransitionDelayMs,
            withTiming(0, {
              duration: revealCoverFadeMs(enterMotionSv.value),
              easing: ENERGETIC_OPEN_EASING,
            }),
          );
        }
        runOnJS(markRevealed)();
      };
      const tick = () => {
        // Смена треда во время ожидания: hideListUntilReady сбросил флаг —
        // показывать нечего, следующий allowListReveal начнёт цикл заново.
        if (!listRevealStartedSv.value) return;
        // Тёплый быстрый путь (revealListNow) уже показал — циклу делать нечего.
        if (listRevealSv.value) return;
        // Тишина лэйаута ленты: onContentSizeChange обнуляет счётчик с JS.
        listLayoutQuietSv.value += 1;
        framesLeft -= 1;
        if (framesLeft <= 0) {
          // Потолок: показываем как есть, предварительно бросив якорь.
          if (pinToBottomSv.value) {
            scrollTo(listAnimatedRef, 0, chatListAnchorOffset(), false);
          }
          reveal();
          return;
        }
        const gatesOpen =
          listLoadedSv.value &&
          listTextReadySv.value &&
          listLayoutQuietSv.value >= listQuietFramesSv.value;
        if (gatesOpen) {
          if (!pinToBottomSv.value) {
            reveal();
            return;
          }
          const target = chatListAnchorOffset();
          if (Platform.OS === "android") {
            // Android: scrollTo(0) при любом сносе шлёт scroll-событие, SV
            // офсета честный. Показ — после 2 кадров подряд ровно на якоре.
            if (Math.abs(listScrollOffsetSv.value - target) > 0.5) {
              if (__DEV__ && anchoredFrames > 0) {
                // Смок-сигнал: якорь был занят и его снесло до показа.
                console.log(
                  `[chat-anchor] снос до показа: ${Math.round(listScrollOffsetSv.value)} → якорь ${Math.round(target)}`,
                );
              }
              scrollTo(listAnimatedRef, 0, target, false);
              anchoredFrames = 0;
            } else {
              // Страховка от застоявшегося SV в первом кадре фазы: явный
              // якорь один раз, даже если офсет уже читается верным.
              if (anchoredFrames === 0) {
                scrollTo(listAnimatedRef, 0, target, false);
              }
              anchoredFrames += 1;
              if (anchoredFrames >= 2) {
                reveal();
                return;
              }
            }
          } else {
            // iOS: setContentOffset в тот же офсет не шлёт события — SV мог
            // застояться; верифицировать нечем. Якорь + два кадра на доезд.
            if (anchoredFrames === 0) {
              scrollTo(listAnimatedRef, 0, target, false);
            }
            anchoredFrames += 1;
            if (anchoredFrames >= 3) {
              reveal();
              return;
            }
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
  }, [
    enterMotionSv,
    listAnimatedRef,
    listEnterCoverSv,
    listLayoutQuietSv,
    listLoadedSv,
    listPlaceholderSv,
    listQuietFramesSv,
    listRevealSv,
    listRevealStartedSv,
    listScrollOffsetSv,
    listTextReadySv,
    markRevealed,
    pinToBottomSv,
    revealAtSv,
    settleLogBudgetSv,
    skipMotionSv,
  ]);

  /**
   * Тёплый быстрый путь показа: экран зовёт из JS-колбэка onLoad, когда
   * раскладка окна финальна (все замеры текста в кэше). Высоты не изменятся —
   * кадры тишины и верификация якоря не нужны, а каждый их кадр плюс
   * runOnJS-роундтрип — лишние ~100–250 мс тёмной заглушки. Показываем в этом
   * же JS-коммите. Применим только на нетронутом якоре: скролл не двигался,
   * инвертированная лента прижата к низу с первого кадра.
   */
  const revealListNow = useCallback(() => {
    if (listRevealSv.value) return;
    if (
      pinToBottomSv.value &&
      Math.abs(listScrollOffsetSv.value - chatListAnchorOffset()) > 0.5
    ) {
      return; // якорь тронут — пусть верифицирует UI-цикл allowListReveal
    }
    listRevealStartedSv.value = true;
    cancelAnimation(listRevealSv);
    cancelAnimation(listPlaceholderSv);
    listRevealSv.value = 1;
    revealAtSv.value = Date.now();
    settleLogBudgetSv.value = SETTLE_TRACE_MAX_LOGS;
    listPlaceholderSv.value = 0;
    // Тот же Flora-фейд входа, что в UI-цикле показа (см. reveal выше).
    cancelAnimation(listEnterCoverSv);
    if (skipMotionSv.value) {
      listEnterCoverSv.value = 0;
    } else {
      listEnterCoverSv.value = 1;
      listEnterCoverSv.value = withDelay(
        floraMotion.tabTransitionDelayMs,
        withTiming(0, {
          duration: revealCoverFadeMs(enterMotionSv.value),
          easing: ENERGETIC_OPEN_EASING,
        }),
      );
    }
    markRevealed();
  }, [
    enterMotionSv,
    listEnterCoverSv,
    listPlaceholderSv,
    listRevealSv,
    listRevealStartedSv,
    listScrollOffsetSv,
    markRevealed,
    pinToBottomSv,
    revealAtSv,
    settleLogBudgetSv,
    skipMotionSv,
  ]);

  // --- Дев-трассировка осадки: что двигает ленту сразу после показа ---

  const logDockSettle = useCallback((tag: string, from: number, to: number, dtMs: number) => {
    console.log(
      `[chat-settle] ${tag} ${Math.round(from)}→${Math.round(to)} (+${Math.round(dtMs)}мс после reveal)`,
    );
  }, []);

  /**
   * Всё, что законно двигает ленту, живёт на этих трёх величинах: зазор под
   * доком (listGapPx, SV-зеркало dockExtraPaddingSv), подъём (клавиатура/панель)
   * и рост поля. Любое их изменение в первые секунды после показа — источник
   * «прыжка» пузырей; лог называет виновника и время. Гейт __DEV__ — внутри
   * тела воркета: функции обязаны стоять прямыми аргументами хука, иначе
   * babel-плагин Reanimated их не воркетизирует (краш на UI-потоке). В release
   * prepare сразу возвращает null — реакция не срабатывает (null не меняется).
   */
  useAnimatedReaction(
    () => {
      if (!__DEV__) return null;
      return {
        pad: dockExtraPaddingSv.value,
        lift: totalLiftSv.value,
        growth: liveComposeGrowthSv.value,
      };
    },
    (cur, prev) => {
      if (!__DEV__ || cur === null || prev == null) return;
      const at = revealAtSv.value;
      if (at <= 0 || settleLogBudgetSv.value <= 0) return;
      if (Date.now() - at > SETTLE_TRACE_WINDOW_MS) return;
      const dt = Date.now() - at;
      if (cur.pad !== prev.pad) {
        settleLogBudgetSv.value -= 1;
        runOnJS(logDockSettle)("dock-pad", prev.pad, cur.pad, dt);
      }
      if (cur.lift !== prev.lift) {
        settleLogBudgetSv.value -= 1;
        runOnJS(logDockSettle)("total-lift", prev.lift, cur.lift, dt);
      }
      if (cur.growth !== prev.growth) {
        settleLogBudgetSv.value -= 1;
        runOnJS(logDockSettle)("compose-growth", prev.growth, cur.growth, dt);
      }
    },
    [logDockSettle],
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
      if (lastMeasuredComposeBaselinePx !== baseline) {
        lastMeasuredComposeBaselinePx = baseline;
        mmkv.set(COMPOSE_BASELINE_MMKV_KEY, baseline);
      }
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
        const baseline = composeBaselineRef.current || COMPOSE_BASELINE_FALLBACK_PX();
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
    composeBaselineSv.value = COMPOSE_BASELINE_FALLBACK_PX();
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
      // JS-зеркало — двигает listGapPx (React-padding ленты).
      setDeleteBarHeightState(height);
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
    setDeleteBarHeightState(0);
    // Не в 0, а к последнему замеру: док одинаков во всех чатах — следующее
    // открытие стартует с готовым listGapPx и снятым гейтом baseline>0
    // (onLayout при совпадении высоты не коммитит вовсе).
    composeBaselineRef.current = lastMeasuredComposeBaselinePx;
    composeBaselineSv.value =
      lastMeasuredComposeBaselinePx || COMPOSE_BASELINE_FALLBACK_PX();
    setComposeBaselinePx(lastMeasuredComposeBaselinePx);
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
    listGapPx,
    listInsetZeroSv,
    freezeListSv,
    listAnimatedRef,
    pinListToBottom,
    setListPinned,
    listPlaceholderStyle,
    listEnterCoverStyle,
    hideListUntilReady,
    allowListReveal,
    setListRevealQuietFrames,
    setListTextLayoutReady,
    revealListNow,
    onListLoad,
    onListContentSizeChange,
    listRevealed,
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
