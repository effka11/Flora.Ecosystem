/**
 * Телеграмный push в языке Flora: чат поверх списка сообщений и создание
 * поста поверх ленты. У каждого свой progress (экраны не делят жест):
 * 0 — список в покое, 1 — верхний экран на месте. Верхний экран заезжает
 * справа непрозрачным слоем (`translateX = (1-p)·width`), список остаётся
 * с лёгким параллаксом влево и затемнением (`-p·PARALLAX·width`, dim `p·DIM`)
 * — без кроссфейда. Кривая и темп — ENERGETIC_OPEN, та же энергия, что у
 * переключения вкладок; назад — то же зеркально (EXIT_MS/EXIT_EASING).
 *
 * Нативный переход выключен (`presentation: "transparentModal"` +
 * `animation: "none"`): RNS свапает сцены мгновенно и держит список видимым
 * под прозрачным экраном, хореографию ведёт Reanimated на UI-потоке.
 * Progress — процесс-глобальный makeMutable (паттерн tabRouteCover): экраны
 * живут в разных ветках native stack, React-контекст ради одного значения
 * не заводим.
 *
 * Протокол — как push в Telegram/iOS: едет ОДИН слой, и этот слой с первого
 * кадра — настоящий экран, а не пустая подложка.
 *
 * Список диалогов: press-in паркует тред за правым краем (progress = 0, без
 * анимации и без фокуса маршрута). Отпускание без скролла коммитит play.
 * Ковёр уже 0 — publishPark один раз до withTiming, слот ещё за краем, тайминг
 * со следующего кадра. Порог 0.01 на заезде подписчиков не будит. Ковёр гаснет
 * позже — runEnter на следующем кадре после listRevealed. Маршрут оболочки
 * пушится в конце withTiming, не на старте. Deep link и reduce motion
 * по-прежнему ставят экран сразу: arm*Enter() → router.push → run*Enter()
 * из useLayoutEffect.
 *
 * Назад: beforeRemove → run*Exit() ведёт progress к 0 и после этого
 * отпускает отложенный pop. Пока оболочки нет, закрытие играет тот же
 * выход от текущего progress и список не pop-ает. Если push не состоялся —
 * страховочный таймер возвращает 0.
 */
import { AccessibilityInfo } from "react-native";
import {
  cancelAnimation,
  makeMutable,
  runOnJS,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import {
  CHAT_PUSH_OFF_EDGE,
  CHAT_WARM_LIVE_MAX,
  CHAT_WARM_RETRY_MAX,
  chatPushBackAction,
  chatPushEnterKickoff,
  chatPushOffEdgeNotifies,
  chatPushPressBlockedByPlay,
  chatPushSlideStartOnCarpet,
  chatWarmMountedIds,
  selectChatWarmMeasureIds,
  type ChatPushShellPhase,
} from "@/lib/chatListEnterMount";
import { createChatWarmAssemblyGate } from "@/lib/chatWarmAssemblyGate";
import { setActiveMessageThread } from "@/lib/activeMessageThread";
import { clearChatOpenAvatarPaint } from "@/lib/chatOpenAvatars";
import { markChatOpenPlay } from "@/lib/chatOpenTrace";
import { ENERGETIC_OPEN_EASING, ENERGETIC_OPEN_MS } from "@/lib/energeticSettle";
import { setFrcImageQueuePaused } from "@/lib/frcImage";

const ENTER_MS = ENERGETIC_OPEN_MS;
const ENTER_EASING = ENERGETIC_OPEN_EASING;
/**
 * Возврат парирует заезд — тот же duration-3 и та же ease-out, что у входа
 * (контракт закрытия меню-гамбургера: OPEN_MS/OPEN_EASING = CLOSE_MS/EASING).
 * Не ENERGETIC_CLOSE: у него другой темп и ease-in, из-за чего обратный ход
 * читался иначе, чем прямой, — жест переставал быть зеркалом.
 */
const EXIT_MS = ENTER_MS;
const EXIT_EASING = ENTER_EASING;

/** Параллакс списка — доля ширины экрана (iOS/Telegram ≈ 30%). */
export const CHAT_PUSH_PARALLAX = 0.3;
/** Затемнение списка на полном ходу верхнего экрана. */
export const CHAT_PUSH_DIM = 0.32;

/** Push не состоялся (гонка/ошибка) — вернуть список на место. */
const CLAIM_TIMEOUT_MS = 1200;

/**
 * Reduce motion читаем сами (не хуком): arm зовут и plain-функции
 * (openGroupChat). До ответа AccessibilityInfo движение пропускаем — та же
 * политика, что shouldSkipFloraMotion.
 */
let reduceMotion: boolean | null = null;
void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
  reduceMotion ??= enabled;
  if (reduceMotion === false) pumpWarm();
});
AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
  reduceMotion = enabled;
});

function skipMotion(): boolean {
  return reduceMotion !== false;
}

type CoverPush = {
  /** 0 — список в покое, 1 — верхний экран полностью накрыл список. */
  progress: SharedValue<number>;
  isExiting: () => boolean;
  armEnter: () => void;
  isEnterArmed: () => boolean;
  /** Слайд из парковки: взвод без таймера и без сброса progress. */
  primeEnter: () => void;
  runEnter: (driven: SharedValue<boolean>, onFinished?: () => void) => void;
  runExit: (driven: SharedValue<boolean>, onDone: () => void, force?: boolean) => boolean;
  reset: () => void;
};

function createCoverPush(): CoverPush {
  const progress = makeMutable(0);
  let armed = false;
  let exiting = false;
  let armSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  function clearArmSafety(): void {
    if (armSafetyTimer != null) {
      clearTimeout(armSafetyTimer);
      armSafetyTimer = null;
    }
  }

  return {
    progress,
    isExiting: () => exiting,
    /**
     * Синхронно ПЕРЕД router.push. Только взводит переход: двигать список
     * до появления верхнего экрана нельзя — это отдельная первая фаза.
     */
    armEnter() {
      if (skipMotion()) return;
      armed = true;
      exiting = false;
      clearArmSafety();
      cancelAnimation(progress);
      progress.value = 0;
      // Верхний экран так и не смонтировался: снимаем взвод, чтобы следующий
      // маунт не сыграл вход задним числом.
      armSafetyTimer = setTimeout(() => {
        armed = false;
      }, CLAIM_TIMEOUT_MS);
    },
    /** Первый рендер, до эффектов: armed-экран уже за правым краем. */
    isEnterArmed() {
      return armed && !skipMotion();
    },
    primeEnter() {
      armed = true;
      exiting = false;
      clearArmSafety();
    },
    /**
     * Первый коммит верхнего экрана: весь слайд разом. Без тапа (deep link,
     * reduce motion) экран встаёт на место мгновенно. `driven` снимается по
     * завершении входа; прерванный вход (finished=false) флаг не снимает.
     */
    runEnter(driven, onFinished) {
      clearArmSafety();
      const play = armed && !skipMotion();
      armed = false;
      exiting = false;
      cancelAnimation(progress);
      if (!play) {
        driven.value = false;
        progress.value = 1;
        onFinished?.();
        return;
      }
      driven.value = true;
      progress.value = 0;
      progress.value = withTiming(
        1,
        { duration: ENTER_MS, easing: ENTER_EASING },
        (finished) => {
          "worklet";
          if (finished) {
            driven.value = false;
            if (onFinished) runOnJS(onFinished)();
          }
        },
      );
    },
    /**
     * Зеркало входа: 1→0, затем onDone (dispatch отложенного pop).
     * false — анимировать нечего: pop идёт немедленно.
     */
    runExit(driven, onDone, force = false) {
      // force — закрытие до оболочки: JS-значение progress отстаёт от кадра,
      // а UI уже вывез чат. withTiming стартует с текущего UI-значения.
      if (skipMotion() || (!force && progress.value <= 0.01)) return false;
      clearArmSafety();
      armed = false;
      exiting = true;
      driven.value = true;
      const finish = () => {
        exiting = false;
        onDone();
      };
      cancelAnimation(progress);
      progress.value = withTiming(
        0,
        { duration: EXIT_MS, easing: EXIT_EASING },
        () => {
          "worklet";
          // Даже прерванная анимация обязана отпустить pop — иначе экран завис.
          runOnJS(finish)();
        },
      );
      return true;
    },
    /** Focus списка: exit уже отыграл; чинит pop без анимации. */
    reset() {
      clearArmSafety();
      armed = false;
      exiting = false;
      cancelAnimation(progress);
      progress.value = 0;
    },
  };
}

const chatPush = createCoverPush();
const composePush = createCoverPush();

/** Отдельный owner слайда чата: пауза декода не делит причину с пейджером ленты. */
const chatSlideFrcOwner = Symbol("chat-push-slide");
let chatSlideImagesPaused = false;

function beginChatSlideImagePause(): void {
  if (chatSlideImagesPaused) return;
  chatSlideImagesPaused = true;
  setFrcImageQueuePaused(chatSlideFrcOwner, "drag", true);
}

function endChatSlideImagePause(): void {
  if (!chatSlideImagesPaused) return;
  chatSlideImagesPaused = false;
  setFrcImageQueuePaused(chatSlideFrcOwner, "drag", false);
}

const dockHitListeners = new Set<(offEdge: boolean) => void>();

/** Хиты дока. Не подписчик publishPark: порог 0.01 заезда этот набор не будит. */
export function subscribeChatPushDockHits(listener: (offEdge: boolean) => void): () => void {
  dockHitListeners.add(listener);
  return () => {
    dockHitListeners.delete(listener);
  };
}

function emitDockHits(offEdge: boolean): void {
  for (const listener of dockHitListeners) listener(offEdge);
}

function finishChatSlideExitFrame(): void {
  endChatSlideImagePause();
  if (chatPush.progress.value <= CHAT_PUSH_OFF_EDGE) emitDockHits(true);
}

/** 0 — список диалогов в покое, 1 — чат полностью накрыл список. */
export const chatPushProgress = chatPush.progress;

/**
 * Играет ли прямо сейчас анимация возврата из чата. Экран треда держит на
 * это время фоновую дорасшифровку истории.
 */
export function isChatPushExiting(): boolean {
  return chatPush.isExiting();
}

/** Строка списка, синхронно перед router.push. */
export function armChatPushEnter(): void {
  chatPush.armEnter();
}

export function isChatPushEnterArmed(): boolean {
  return chatPush.isEnterArmed();
}

export function runChatPushEnter(driven: SharedValue<boolean>): void {
  markChatOpenPlay();
  emitDockHits(false);
  beginChatSlideImagePause();
  chatPush.runEnter(driven, endChatSlideImagePause);
}

export function runChatPushExit(
  driven: SharedValue<boolean>,
  onDone: () => void,
): boolean {
  const nextEpoch = reverseEpoch + 1;
  const started = chatPush.runExit(driven, () => {
    if (nextEpoch !== reverseEpoch) return;
    finishChatSlideExitFrame();
    if (parkPhase === "parked" || parkPhase === "play-wait") return;
    onDone();
  });
  if (!started) return false;
  beginChatSlideImagePause();
  // Слайд ещё едет, но hit-box больше не накрывает список и таб-бар.
  exitPopArmed = true;
  reverseEpoch = nextEpoch;
  slideEpoch += 1;
  setChatPushOffEdge(true);
  return true;
}

/**
 * Конец слайда. Оболочку маршрута уже сняли, тред на оверлее не разбираем:
 * те же bitmap'ы аватаров держит список, и unmount заставляет их мигнуть.
 */
export function completeChatPushExitVisual(): void {
  if (parkPhase === "parked" || parkPhase === "play-wait") return;
  if (parkPhase !== "playing") return;
  retainChatPushOffEdge();
}

export function resetChatPushProgress(): void {
  // Фокус списка возвращается в тот же кадр, что и pop оболочки. Слайд
  // ещё на оверлее — сброс здесь оборвал бы уход. progress = 0 здесь не pop.
  if (chatPush.isExiting()) return;
  // Переподписка фокуса списка не снимает парковку и ещё не доехавший слайд:
  // список остаётся в фокусе, пока оболочка не запушена.
  if (parkPhase === "parked" || parkPhase === "play-wait") return;
  if (parkPhase === "playing" && !shellPushed) return;
  exitPopArmed = false;
  releaseChatPark();
  chatPush.reset();
}

/**
 * Парковка треда до play. Оверлей, не маршрут: список остаётся в фокусе,
 * таб-бар не прячется. Оболочка пушится в конце слайда, когда фаза уже
 * playing, и не монтирует второй FlashList — живой остаётся оверлей.
 */
export type ChatPushParkParams = {
  conversationUuid: string;
  kind?: string;
  title?: string;
  otherUserUuid?: string;
  otherDisplayName?: string;
  otherUsername?: string;
  otherAvatarUuid?: string;
  otherAccountBlocked?: string;
  otherUserIsOnline?: string;
  otherUserLastSeenAt?: string;
};

type ChatParkPhase = "idle" | "parked" | "play-wait" | "playing";

const parkListeners = new Set<() => void>();
let parkPhase: ChatParkPhase = "idle";
let parkedUuid: string | null = null;
/** Ковёр уже 0 и listRevealed закоммичен. До этого слайд не стартует. */
let parkCarpetDown = false;
let parkNavigate: (() => void) | null = null;
let overlaySnap: ChatPushParkParams | null = null;
let holdingSnap = false;
let slidingSnap = false;
/** Снимок exiting на публикации. Живой флаг читает isChatPushExiting. */
let exitingSnap = false;
/**
 * Заезд опубликован, React ещё видит кадр за краем. Хост остаётся сверху,
 * пока withTiming не доехал и конец слайда не снял offEdge.
 */
let enterPaintSnap = false;
let enterGeneration = 0;
let enteredGeneration = -1;
let drivenRef: SharedValue<boolean> | null = null;
let scrollCancelledPark = false;
/**
 * Play закоммичен. Layout-эффект не зовёт runEnter: вход идёт из
 * request/carpet, а после слайда — не второй раз.
 */
let slideHold = false;
/** Оболочка уже запушена. До этого back снимает парк и маршрут не толкает. */
let shellPushed = false;
/**
 * Маршрут оболочки ещё смонтирован. Не равен `shellPushed`: retain сбрасывает
 * флаг пуша, пока прозрачный экран ещё в стеке.
 */
let chatShellInStack = false;
/** runChatPushExit уже начат. park и reset фокуса списка снимают, чтобы не pop. */
let exitPopArmed = false;
let enterStarted = false;
/** Инкремент отменяет отложенный runEnter и поздний колбэк withTiming. */
let slideEpoch = 0;
/** Эпоха входа, которую ждёт стабильный колбэк withTiming. */
let parkedEnterEpoch = 0;
/** Эпоха обратного слайда до оболочки. Новый press её отменяет. */
let reverseEpoch = 0;
/**
 * UI-поток уже видит чат за правым краем. JS-значение progress на старте
 * withTiming отстаёт, поэтому хиты и back смотрят сюда.
 */
let exitOffEdge = true;
/** Парковка строки после кадра подсветки, чтобы Pressable успел отрисоваться. */
let pendingParkRun: (() => void) | null = null;
let pendingParkFrame: number | null = null;

/**
 * Окна чатов, собранные до тапа. Высоты и картинки закрывает тот же ковёр,
 * что и парк пальца: слайд чужого чата стартует уже с `parkCarpetDown`.
 * Слоты берут треды с уже расшифрованным хвостом, пачкой до лимита.
 * Закрытые остаются смонтированными.
 */
type WarmEntry = {
  params: ChatPushParkParams;
  closed: boolean;
  yielded: boolean;
  started: boolean;
  /**
   * Сколько раз yielded-окно получало слот снова. Экран не ремоунтится —
   * новый номер попытки перепроверяет высоты и круги на том же инстансе.
   */
  attempt: number;
};

export type ChatWarmSlot = {
  id: string;
  params: ChatPushParkParams;
  /** Номер попытки замера; меняется только на повторе yielded-окна. */
  attempt: number;
  /** Окно уже закрыто высотами и bitmap. Слот остаётся в дереве. */
  closed: boolean;
};

const warmListeners = new Set<() => void>();
const warmById = new Map<string, WarmEntry>();
let warmOrder: string[] = [];
let assemblyEnabled = false;
let warmSnap: readonly ChatWarmSlot[] = [];
/** Хвост уже терминален. Список подставляет, очередь читает в момент слота. */
let warmPageCached: ((conversationUuid: string) => boolean) | null = null;
/** Страница в кэше, но хвост ещё не терминален. Холодный слот такой чат не берёт. */
let warmPageHeld: ((conversationUuid: string) => boolean) | null = null;
/**
 * Холодный чат без страницы в кэше не монтируем, пока лёгкий прогрев не
 * отдал топ. Иначе три FlashList спорят с расшифровкой и слоты стоят.
 */
let warmColdAllowed = false;
let coldFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const CHAT_WARM_COLD_FALLBACK_MS = 2500;

function normParkUuid(uuid: string): string {
  return uuid.trim().toLowerCase();
}

function publishPark(): void {
  holdingSnap = parkPhase === "parked" || parkPhase === "play-wait";
  slidingSnap = parkPhase === "playing";
  // Снятие парка уже idle: живой exiting сбрасывает reset следом, хост не держим.
  exitingSnap = parkPhase !== "idle" && chatPush.isExiting();
  enterPaintSnap = enterStarted && parkPhase === "playing" && exitOffEdge && !exitingSnap;
  for (const listener of parkListeners) listener();
}

function warmParamsKey(params: ChatPushParkParams): string {
  return [
    params.conversationUuid,
    params.kind ?? "",
    params.title ?? "",
    params.otherUserUuid ?? "",
    params.otherDisplayName ?? "",
    params.otherUsername ?? "",
    params.otherAvatarUuid ?? "",
    params.otherAccountBlocked ?? "",
  ].join("\u0001");
}

function slideOccupiesWarm(): boolean {
  if (chatPush.isExiting()) return true;
  if (parkPhase !== "playing") return false;
  // Оболочка запушена, выход не идёт: чат стоит на месте. Пуш треда сборку
  // не гасит — хост скамьи живёт в лэйауте, следующие окна собираются под ним.
  if (shellPushed) return false;
  // Удержанный за краем после выхода — очередь может собирать следующий.
  // slideHold: play уже запрошен, enterStarted ещё нет — это тоже слайд.
  if (!enterStarted && !slideHold && exitOffEdge) return false;
  return true;
}

function parkedMeasuringId(): string | null {
  if (parkPhase !== "parked" && parkPhase !== "play-wait") return null;
  if (parkedUuid == null) return null;
  if (warmById.get(parkedUuid)?.closed === true) return null;
  return parkedUuid;
}

function rebuildWarmSnap(): readonly ChatWarmSlot[] {
  const startedIds: string[] = [];
  for (const [id, entry] of warmById) {
    if (entry.started) startedIds.push(id);
  }
  const activeId = parkPhase === "idle" ? null : parkedUuid;
  const ids = chatWarmMountedIds({
    order: warmOrder,
    startedIds,
    measuringId: null,
    activeId,
  });
  const slots: ChatWarmSlot[] = [];
  for (const id of ids) {
    const entry = warmById.get(id);
    const params =
      entry?.params ??
      (overlaySnap != null && normParkUuid(overlaySnap.conversationUuid) === id ? overlaySnap : null);
    if (params == null) continue;
    slots.push({ id, params, attempt: entry?.attempt ?? 0, closed: entry?.closed === true });
  }
  return slots;
}

function warmSnapSame(prev: readonly ChatWarmSlot[], next: readonly ChatWarmSlot[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (
      a == null ||
      b == null ||
      a.id !== b.id ||
      a.params !== b.params ||
      a.attempt !== b.attempt ||
      a.closed !== b.closed
    ) {
      return false;
    }
  }
  return true;
}

function publishWarm(): void {
  const next = rebuildWarmSnap();
  if (warmSnapSame(warmSnap, next)) return;
  warmSnap = next;
  for (const listener of warmListeners) listener();
}

function warmInFlightIds(): string[] {
  const ids: string[] = [];
  for (const id of warmOrder) {
    const entry = warmById.get(id);
    if (entry == null || !entry.started || entry.closed || entry.yielded) continue;
    ids.push(id);
  }
  return ids;
}

function warmIdsWhere(probe: ((conversationUuid: string) => boolean) | null): string[] {
  if (probe == null) return [];
  const ids: string[] = [];
  for (const id of warmOrder) {
    if (probe(id)) ids.push(id);
  }
  return ids;
}

function warmCachedIds(): string[] {
  return warmIdsWhere(warmPageCached);
}

function warmHeldIds(): string[] {
  return warmIdsWhere(warmPageHeld);
}

function warmLiveCount(): number {
  let count = 0;
  for (const entry of warmById.values()) {
    if (entry.started && !entry.closed) count += 1;
  }
  return count;
}

function armColdFallback(): void {
  if (warmColdAllowed || coldFallbackTimer != null) return;
  coldFallbackTimer = setTimeout(() => {
    coldFallbackTimer = null;
    if (!assemblyEnabled) return;
    warmColdAllowed = true;
    pumpWarm();
  }, CHAT_WARM_COLD_FALLBACK_MS);
}

function pumpWarm(): void {
  if (skipMotion()) return;
  // Уже едущий слайд не начинает новые окна. Те, что уже в дереве, остаются.
  if (slideOccupiesWarm()) return;
  const finger = parkedMeasuringId();
  if (!assemblyEnabled && finger == null) return;
  const closedIds: string[] = [];
  const yieldedIds: string[] = [];
  const retryIds: string[] = [];
  for (const [id, entry] of warmById) {
    if (entry.closed) closedIds.push(id);
    if (entry.yielded) {
      yieldedIds.push(id);
      if (entry.attempt < CHAT_WARM_RETRY_MAX) retryIds.push(id);
    }
  }
  const desired = selectChatWarmMeasureIds({
    order: warmOrder,
    cachedIds: warmCachedIds(),
    closedIds,
    yieldedIds,
    inFlightIds: warmInFlightIds(),
    slideBusy: false,
    assemblyEnabled: assemblyEnabled || finger != null,
    parkedMeasuringId: finger,
    allowUncached: warmColdAllowed,
    heldIds: warmHeldIds(),
    retryIds,
  });
  // Свободные слоты — в этом проходе. По одному на кадр очередь не успевала:
  // следующий кадр приходил уже после расшифровки чужого треда.
  let changed = false;
  let live = warmLiveCount();
  for (const id of desired) {
    const entry = warmById.get(id);
    if (entry == null) continue;
    if (entry.yielded) {
      // Повтор yielded-окна: экран уже в дереве (live его считает), слот снова
      // его. Новый номер попытки перепроверяет высоты и круги без ремоунта.
      entry.yielded = false;
      entry.attempt += 1;
      changed = true;
      continue;
    }
    if (entry.started) continue;
    if (live >= CHAT_WARM_LIVE_MAX && id !== finger) continue;
    entry.started = true;
    live += 1;
    changed = true;
  }
  if (changed) publishWarm();
}

function warmPeerStillAssembling(id: string): boolean {
  for (const [otherId, other] of warmById) {
    if (otherId !== id && other.started && !other.closed) return true;
  }
  return false;
}

function rememberWarmTarget(params: ChatPushParkParams): WarmEntry {
  const id = normParkUuid(params.conversationUuid);
  const prev = warmById.get(id);
  if (prev) {
    prev.params = params;
    prev.started = true;
    return prev;
  }
  const entry: WarmEntry = {
    params,
    closed: false,
    yielded: false,
    started: true,
    attempt: 0,
  };
  warmById.set(id, entry);
  warmOrder = [id, ...warmOrder.filter((existing) => existing !== id)];
  return entry;
}

function markWarmWindowClosed(id: string | null): void {
  if (id == null) return;
  const entry = warmById.get(id);
  if (entry == null || entry.closed) return;
  entry.closed = true;
  entry.yielded = false;
  entry.started = true;
}

function releaseChatPark(): void {
  exitPopArmed = false;
  slideEpoch += 1;
  reverseEpoch += 1;
  exitOffEdge = true;
  parkPhase = "idle";
  parkedUuid = null;
  parkCarpetDown = false;
  parkNavigate = null;
  overlaySnap = null;
  enterGeneration = 0;
  enteredGeneration = -1;
  slideHold = false;
  shellPushed = false;
  enterStarted = false;
  endChatSlideImagePause();
  emitDockHits(true);
  publishPark();
}

/**
 * Слайд доиграл, чат за правым краем. Оверлей и его картинки остаются:
 * следующий заход того же треда не монтирует их заново, список не мигает.
 * Публикуем снятый exiting: holding и sliding не меняются, тред по своим
 * снимкам не перерисовывается, хост уходит под список.
 */
function retainChatPushOffEdge(): void {
  if (overlaySnap == null || parkedUuid == null) {
    releaseChatPark();
    chatPush.reset();
    return;
  }
  slideEpoch += 1;
  reverseEpoch += 1;
  exitOffEdge = true;
  shellPushed = false;
  enterStarted = false;
  slideHold = false;
  setActiveMessageThread(null);
  markWarmWindowClosed(parkedUuid);
  chatPush.reset();
  endChatSlideImagePause();
  publishPark();
  publishWarm();
  pumpWarm();
}

export function subscribeChatPush(listener: () => void): () => void {
  parkListeners.add(listener);
  return () => {
    parkListeners.delete(listener);
  };
}

export function getChatPushHolding(): boolean {
  return holdingSnap;
}

export function getChatPushOffEdge(): boolean {
  return exitOffEdge;
}

/**
 * С UI-потока: progress пересёк край. На заезде порог 0.01 пишет флаг для
 * press, pop оболочки и хитов и не будит подписчиков. Выход публикует сразу.
 */
export function setChatPushOffEdge(off: boolean): void {
  if (exitOffEdge === off) return;
  const notify = chatPushOffEdgeNotifies({
    prevOff: exitOffEdge,
    nextOff: off,
    enterTiming: enterStarted && !chatPush.isExiting(),
  });
  exitOffEdge = off;
  if (notify) publishPark();
}

export function getChatPushExiting(): boolean {
  return exitingSnap;
}

export function getChatPushEnterPaint(): boolean {
  return enterPaintSnap;
}

export function getChatPushSliding(): boolean {
  return slidingSnap;
}

export function getChatPushEnterGeneration(): number {
  return enterGeneration;
}

export function getChatPushOverlay(): ChatPushParkParams | null {
  return overlaySnap;
}

export function subscribeChatWarm(listener: () => void): () => void {
  warmListeners.add(listener);
  return () => {
    warmListeners.delete(listener);
  };
}

/** Смонтированные окна. Снимок стабилен, пока набор и params не сменились. */
export function getChatWarmBench(): readonly ChatWarmSlot[] {
  return warmSnap;
}

/**
 * Порядок чатов списка. Новые не монтируются все сразу: `pumpWarm` берёт один.
 * Уже закрытые остаются, пока uuid есть в этом списке.
 */
export function syncChatWarmTargets(params: readonly ChatPushParkParams[]): void {
  const nextOrder: string[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const raw of params) {
    const id = normParkUuid(raw.conversationUuid);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nextOrder.push(id);
    const prev = warmById.get(id);
    if (prev == null) {
      warmById.set(id, {
        params: raw,
        closed: false,
        yielded: false,
        started: false,
        attempt: 0,
      });
      changed = true;
    } else if (warmParamsKey(prev.params) !== warmParamsKey(raw)) {
      prev.params = raw;
      changed = true;
    }
  }
  for (const id of [...warmById.keys()]) {
    if (seen.has(id)) continue;
    const active = parkedUuid === id && parkPhase !== "idle";
    if (active) {
      nextOrder.push(id);
      continue;
    }
    warmById.delete(id);
    changed = true;
  }
  if (nextOrder.join("\u0001") !== warmOrder.join("\u0001")) {
    warmOrder = nextOrder;
    changed = true;
  }
  if (changed) publishWarm();
  pumpWarm();
}

/**
 * Вкладка Messages на экране и ничто не скроллится. Иначе очередь не начинает
 * новый замер. Экраны сюда не пишут напрямую — только через гейт ниже.
 */
export function setChatWarmAssemblyEnabled(enabled: boolean): void {
  if (!enabled && coldFallbackTimer != null) {
    clearTimeout(coldFallbackTimer);
    coldFallbackTimer = null;
  }
  if (enabled) armColdFallback();
  if (assemblyEnabled === enabled) {
    if (enabled) pumpWarm();
    return;
  }
  assemblyEnabled = enabled;
  pumpWarm();
}

/**
 * Кто разрешает сборку: экраны вкладки (список, оболочка треда) — фокусом,
 * список и открытый тред — скроллом. Пуш треда снимает фокус со списка, но
 * оболочка тут же берёт его сама, и очередь продолжает под открытым чатом.
 * Выключение сразу, включение — следующим кадром или после `settleMs`.
 */
const warmGate = createChatWarmAssemblyGate({
  apply: setChatWarmAssemblyEnabled,
  schedule: (run, settleMs) => {
    if (settleMs > 0) {
      const timer = setTimeout(run, settleMs);
      return () => clearTimeout(timer);
    }
    const frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  },
});

/** Экран вкладки Messages получил или потерял фокус маршрута. */
export function setChatWarmScreenFocused(owner: symbol, focused: boolean, settleMs = 0): void {
  warmGate.setScreenFocused(owner, focused, settleMs);
}

/** Список или открытый тред в движении: новые окна не начинать. */
export function setChatWarmScrollBusy(owner: symbol, busy: boolean): void {
  warmGate.setScrollBusy(owner, busy);
}

/** Unmount экрана: снять его фокус и скролл разом. */
export function clearChatWarmGateOwner(owner: symbol): void {
  warmGate.clearOwner(owner);
}

/** Страница треда уже в кэше — можно собрать её окно, не дожидаясь конца очереди. */
export function kickChatWarmAssembly(): void {
  pumpWarm();
}

/** Лёгкий прогрев топа закончился: дальше слоты можно отдавать и холодным чатам. */
export function allowChatWarmColdFill(): void {
  if (coldFallbackTimer != null) {
    clearTimeout(coldFallbackTimer);
    coldFallbackTimer = null;
  }
  warmColdAllowed = true;
  pumpWarm();
}

/** Есть ли первая страница треда уже в кэше. Без подписки списка на каждый ответ. */
export function setChatWarmCachedProbe(
  probe: ((conversationUuid: string) => boolean) | null,
): void {
  warmPageCached = probe;
}

/** Страница есть, хвост ещё нет. Такие чаты не занимают холодный слот. */
export function setChatWarmHeldProbe(
  probe: ((conversationUuid: string) => boolean) | null,
): void {
  warmPageHeld = probe;
}

/** Ковёр этого треда погашен реальными высотами. Очередь берёт следующий. */
export function notifyChatWarmWindowClosed(conversationUuid: string): void {
  const id = normParkUuid(conversationUuid);
  const entry = warmById.get(id);
  if (entry == null || entry.closed) return;
  markWarmWindowClosed(id);
  publishWarm();
  pumpWarm();
}

/**
 * Дедлайн без закрытого окна. Слот замера отпускаем, экран не помечаем готовым:
 * слайд такого чата по-прежнему ждёт настоящий ковёр.
 */
export function notifyChatWarmMeasureYielded(conversationUuid: string): void {
  const id = normParkUuid(conversationUuid);
  const entry = warmById.get(id);
  if (entry == null || entry.closed) return;
  if (entry.yielded) return;
  entry.yielded = true;
  publishWarm();
  pumpWarm();
}

export function isChatPushOverlayOwner(conversationUuid: string): boolean {
  if (overlaySnap == null || parkPhase !== "playing") return false;
  return normParkUuid(overlaySnap.conversationUuid) === normParkUuid(conversationUuid);
}

export function registerChatPushDriven(driven: SharedValue<boolean>): void {
  drivenRef = driven;
}

/** Снятие только своего shared value: чужой cleanup не обнуляет активный слайд. */
export function unregisterChatPushDriven(driven: SharedValue<boolean>): void {
  if (drivenRef === driven) drivenRef = null;
}

export function getChatPushDriven(): SharedValue<boolean> | null {
  return drivenRef;
}

export function didAlreadyRunChatPushEnter(): boolean {
  return enteredGeneration > 0 && enteredGeneration === enterGeneration;
}

export function isChatPushHoldingSlide(): boolean {
  return holdingSnap;
}

/** Play закоммичен: layout-эффект не зовёт второй runEnter. */
export function isChatPushSlideHeld(): boolean {
  return slideHold;
}

/** Отпускание уже было. Повторный тап не паркует другой чат и не пушит маршрут. */
export function isChatPushPlayCommitted(): boolean {
  return parkPhase === "playing";
}

/** Press списка глотается, только пока уехавший чат ещё закрывает экран. */
export function isChatPushPressBlocked(): boolean {
  return chatPushPressBlockedByPlay({
    playCommitted: parkPhase === "playing",
    offEdge: exitOffEdge,
  });
}

/**
 * Выход уже увёл чат за край, а фаза ещё `playing` (фокус списка не сбросил).
 * Следующий press снова паркует этот uuid, ковёр того же треда не сбрасывается.
 */
function reviveOffEdgePlay(): void {
  if (parkPhase !== "playing" || !exitOffEdge) return;
  reverseEpoch += 1;
  slideEpoch += 1;
  enterStarted = false;
  slideHold = false;
  shellPushed = false;
  parkPhase = "parked";
  // Паузу декода снимаем здесь: поздний колбэк выхода уже другой эпохи и
  // не должен трогать следующий слайд. Хиты дока — только порог 0.01.
  endChatSlideImagePause();
  publishPark();
}

/** Перед request play: вернуть парковку, если выход уже освободил экран. */
export function prepareChatPushPress(): void {
  reviveOffEdgePlay();
}

function releaseParkAtEdge(): void {
  exitPopArmed = false;
  reverseEpoch += 1;
  cancelAnimation(chatPush.progress);
  chatPush.progress.value = 0;
  exitOffEdge = true;
  // Play помечает тред до оболочки. Снятие парка без маршрута иначе
  // оставляет prefetch выключенным: экран на скамье cleanup не ставил.
  setActiveMessageThread(null);
  releaseChatPark();
  chatPush.reset();
}

function beginReverseExit(): void {
  const epoch = ++reverseEpoch;
  slideEpoch += 1;
  const driven = drivenRef;
  if (!driven) {
    releaseParkAtEdge();
    return;
  }
  const started = chatPush.runExit(
    driven,
    () => {
      if (epoch !== reverseEpoch) return;
      finishChatSlideExitFrame();
      if (parkPhase === "parked" || parkPhase === "play-wait") return;
      retainChatPushOffEdge();
    },
    true,
  );
  if (started) {
    beginChatSlideImagePause();
    setChatPushOffEdge(true);
  }
  if (!started) releaseParkAtEdge();
}

export function isChatPushExitPopArmed(): boolean {
  return exitPopArmed;
}

/** Снять взвод pop. park и возврат фокуса списка зовут до записи progress = 0. */
export function disarmChatPushExitPop(): void {
  exitPopArmed = false;
}

export function setChatPushShellInStack(inStack: boolean): void {
  chatShellInStack = inStack;
}

export function getChatPushShellInStack(): boolean {
  return chatShellInStack;
}

export function getChatPushParkPhase(): ChatPushShellPhase {
  return parkPhase;
}

/**
 * Шапка и аппаратный back. `handled` — список не pop-ать.
 * `route` — оболочка ещё в стеке: pop сразу, слайд остаётся на оверлее.
 */
export function dismissChatPush(): "handled" | "route" {
  const action = chatPushBackAction({
    shellPushed,
    shellInStack: chatShellInStack,
    active: parkPhase !== "idle",
    offEdge: exitOffEdge,
    exiting: chatPush.isExiting(),
  });
  if (action === "pop-route") return "route";
  if (action === "keep") return "handled";
  if (action === "release") {
    releaseParkAtEdge();
    return "handled";
  }
  beginReverseExit();
  return "handled";
}

/**
 * Back, пока оболочки ещё нет: обратный слайд от текущего progress, затем
 * снять парк. false — оболочка уже в стеке, выход играет beforeRemove.
 */
export function abortChatPushBeforeShell(): boolean {
  return dismissChatPush() === "handled";
}

/** Тот же uuid уже стоит за краем или едет — второй push не нужен. */
export function isChatPushTracked(conversationUuid: string): boolean {
  if (parkedUuid == null) return false;
  if (parkPhase === "idle") return false;
  return parkedUuid === normParkUuid(conversationUuid);
}

/**
 * press-in. `skipped` — reduce motion, вызывающий открывает сразу.
 * `same` — этот uuid уже припаркован, маршрут не толкать.
 */
export function parkChatPush(args: {
  params: ChatPushParkParams;
  navigate: () => void;
}): "skipped" | "same" | "parked" {
  if (skipMotion()) return "skipped";
  const id = normParkUuid(args.params.conversationUuid);
  if (!id) return "skipped";
  scrollCancelledPark = false;
  // Чат ещё на экране — чужой uuid не подменяет парк.
  // Заезд уже принят, кадр ещё не пересёк 0.01: второй press не возвращает hold.
  // За краем после выхода фаза playing больше не держит press: uuid паркуется снова.
  if (parkPhase === "playing" && (!exitOffEdge || (enterStarted && !chatPush.isExiting()))) {
    return "same";
  }
  reviveOffEdgePlay();
  if ((parkPhase === "parked" || parkPhase === "play-wait") && parkedUuid === id) {
    return "same";
  }
  const entry = rememberWarmTarget(args.params);
  parkPhase = "parked";
  parkedUuid = id;
  // Уже собранное окно не открываем заново: слайд стартует в этом отпускании.
  parkCarpetDown = entry.closed;
  if (!entry.closed && !warmPeerStillAssembling(id)) clearChatOpenAvatarPaint();
  parkNavigate = args.navigate;
  overlaySnap = args.params;
  // Предыдущий экран ещё держит driven до коммита. Вход нового — следующий кадр.
  // progress = 0 здесь — следующий чат, не конец выхода. Pop оболочки не звать.
  drivenRef = null;
  exitPopArmed = false;
  cancelAnimation(chatPush.progress);
  chatPush.progress.value = 0;
  publishWarm();
  publishPark();
  return "parked";
}

export function didScrollCancelChatPark(): boolean {
  const cancelled = scrollCancelledPark;
  scrollCancelledPark = false;
  return cancelled;
}

/**
 * Кадр подсветки строки раньше монтажа треда. Быстрый тап сбрасывает
 * отложенную парковку в onPress, скролл её отменяет.
 */
export function scheduleChatRowPark(run: () => void): void {
  pendingParkRun = run;
  if (pendingParkFrame != null) return;
  pendingParkFrame = requestAnimationFrame(() => {
    pendingParkFrame = null;
    const runNow = pendingParkRun;
    pendingParkRun = null;
    runNow?.();
  });
}

export function flushScheduledChatRowPark(): void {
  if (pendingParkFrame != null) {
    cancelAnimationFrame(pendingParkFrame);
    pendingParkFrame = null;
  }
  const runNow = pendingParkRun;
  pendingParkRun = null;
  runNow?.();
}

export function cancelScheduledChatRowPark(): void {
  if (pendingParkFrame != null) {
    cancelAnimationFrame(pendingParkFrame);
    pendingParkFrame = null;
  }
  pendingParkRun = null;
}

/** Жест стал скроллом до отпускания. После play отмена не действует. */
export function cancelChatPushParkFromScroll(): void {
  const hadSchedule = pendingParkRun != null || pendingParkFrame != null;
  cancelScheduledChatRowPark();
  if (parkPhase !== "parked" && parkPhase !== "play-wait") {
    if (hadSchedule) scrollCancelledPark = true;
    return;
  }
  scrollCancelledPark = true;
  releaseChatPark();
  chatPush.reset();
}

/** Уход со списка, пока палец ещё не отпущен. */
export function cancelChatPushParkFromLeave(): void {
  cancelScheduledChatRowPark();
  if (parkPhase !== "parked" && parkPhase !== "play-wait") return;
  releaseChatPark();
  chatPush.reset();
}

/** Монтаж ленты слайд не стартует. */
export function notifyChatPushListMounted(conversationUuid: string): void {
  if (parkedUuid == null || normParkUuid(conversationUuid) !== parkedUuid) return;
}

/**
 * Ковёр погашен после коммита listRevealed. Палец ещё на строке — только
 * запоминаем. Палец уже поднят — runEnter на следующем кадре, без маршрута.
 */
export function notifyChatPushWindowClosed(conversationUuid: string): void {
  if (parkedUuid == null || normParkUuid(conversationUuid) !== parkedUuid) return;
  if (parkCarpetDown) return;
  parkCarpetDown = true;
  scheduleParkedEnter(
    chatPushSlideStartOnCarpet({ playRequested: parkPhase === "playing" }),
  );
}

/**
 * Отпускание без скролла. Первое отпускание прогретого чата в этот же тап
 * вызывает runEnter. publishPark — один раз до withTiming, слот ещё за краем.
 * Порог 0.01 посреди слайда подписчиков не будит. Ковёр ещё не 0 — ждём его.
 * Тред помечаем активным здесь: пока holding, экран его не ставит, и
 * decrypt-window не отдаёт JS.
 */
export function requestChatPushPlay(conversationUuid: string): void {
  if (parkedUuid == null || normParkUuid(conversationUuid) !== parkedUuid) return;
  if (parkPhase !== "parked" && parkPhase !== "play-wait") return;
  setActiveMessageThread(conversationUuid);
  parkPhase = "playing";
  slideHold = true;
  const kickoff = chatPushEnterKickoff({
    scrollCancelled: false,
    carpetDown: parkCarpetDown,
  });
  scheduleParkedEnter({
    runEnter: kickoff.runEnter,
    waitFrames: 0,
  });
}

function scheduleParkedEnter(issue: { runEnter: boolean; waitFrames: number }): void {
  if (!issue.runEnter || issue.waitFrames < 0) return;
  const epoch = ++slideEpoch;
  const start = () => {
    if (epoch !== slideEpoch) return;
    startParkedEnter(epoch);
  };
  if (issue.waitFrames === 0) {
    start();
    return;
  }
  requestAnimationFrame(start);
}

function startParkedEnter(epoch: number, attempt = 0): void {
  if (epoch !== slideEpoch || enterStarted || shellPushed || parkPhase !== "playing") return;
  const driven = drivenRef;
  if (!driven) {
    if (attempt >= 2) return;
    requestAnimationFrame(() => startParkedEnter(epoch, attempt + 1));
    return;
  }
  enterStarted = true;
  enterGeneration += 1;
  enteredGeneration = enterGeneration;
  parkedEnterEpoch = epoch;
  chatPush.primeEnter();
  markChatOpenPlay();
  // Фаза уходит подписчикам, пока translateX ещё screenWidth. withTiming — следующий кадр.
  publishPark();
  emitDockHits(false);
  requestAnimationFrame(() => {
    if (epoch !== slideEpoch || parkPhase !== "playing") return;
    beginChatSlideImagePause();
    chatPush.runEnter(driven, () => {
      if (parkedEnterEpoch !== slideEpoch) return;
      endChatSlideImagePause();
      finishParkedEnterFromUi();
    });
  });
}

function finishParkedEnterFromUi(): void {
  if (parkedEnterEpoch !== slideEpoch) return;
  completeParkedEnter();
}

/** Конец withTiming. Фаза уже playing — первый рендер маршрута это оболочка. */
function completeParkedEnter(): void {
  if (parkPhase !== "playing" || shellPushed) return;
  shellPushed = true;
  if (chatPush.progress.value > CHAT_PUSH_OFF_EDGE) exitOffEdge = false;
  publishPark();
  parkNavigate?.();
}

/** 0 — лента в покое, 1 — создание поста полностью накрыло ленту. */
export const composePushProgress = composePush.progress;

/** «Создать пост» в шапке ленты, синхронно перед router.push. */
export function armComposePushEnter(): void {
  composePush.armEnter();
}

export function isComposePushEnterArmed(): boolean {
  return composePush.isEnterArmed();
}

export function runComposePushEnter(driven: SharedValue<boolean>): void {
  composePush.runEnter(driven);
}

export function runComposePushExit(
  driven: SharedValue<boolean>,
  onDone: () => void,
): boolean {
  return composePush.runExit(driven, onDone);
}

export function resetComposePushProgress(): void {
  composePush.reset();
}
