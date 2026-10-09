/**
 * Когда монтировать ленту и когда гасить ковёр на открытии чата.
 * Без RN: экран подставляет progress входа и факт закрытия окна высотами.
 *
 * Парковка (экран за правым краем, слайд ещё не начат) монтирует FlashList,
 * чтобы коммит пузырей закончился до runEnter. Если слайд уже едет, а ленты
 * ещё нет — не монтировать: коммит не кладётся в движение. Уже смонтированная
 * лента на слайде и на выходе не снимается.
 */

/** Решение тёплого layout-эффекта: диагностика, не показ. */
export type WarmLayoutRevealAction = "gate-off" | "wait-mount" | "hold";

export function warmLayoutRevealAction(args: {
  gateOn: boolean;
  listMounted: boolean;
  /** Тёплый предикат кэша. На показ из этого эффекта не влияет. */
  diagnosisWarm: boolean;
}): WarmLayoutRevealAction {
  if (!args.gateOn) return "gate-off";
  if (!args.listMounted) return "wait-mount";
  if (args.diagnosisWarm) return "hold";
  return "hold";
}

/**
 * Показ из тёплого layout-эффекта — только в парковке, когда окно уже
 * закрыто высотами. На едущем слайде и до замера этот эффект ковёр не гасит.
 */
export function warmLayoutEffectMayReveal(args: {
  gateOn: boolean;
  listMounted: boolean;
  /** Диагностика кэша. На разрешение показа из парковки не влияет. */
  diagnosisWarm: boolean;
  parked: boolean;
  windowClosedByHeights: boolean;
}): boolean {
  void args.diagnosisWarm;
  return args.gateOn && args.listMounted && args.parked && args.windowClosedByHeights;
}

/**
 * Предикат монтажа и закрытия окна высотами. На старт движения не влияет:
 * слайд решает `chatPushSlideStartOnRelease` / `chatPushSlideStartOnCarpet`.
 */
export function canIssueChatPushPlay(args: {
  listMounted: boolean;
  windowClosedByHeights: boolean;
}): boolean {
  return args.listMounted && args.windowClosedByHeights;
}

/**
 * Старт слайда. Маршрут здесь не пушится: оболочка встаёт в конце withTiming.
 * `waitFrames` 0 — runEnter в этом вызове. 1 — следующий кадр после коммита ковра.
 */
export type ChatPushSlideStart = {
  runEnter: boolean;
  waitFrames: 0 | 1;
  pushRoute: false;
};

const SLIDE_HOLD: ChatPushSlideStart = { runEnter: false, waitFrames: 0, pushRoute: false };

/** Отпускание без скролла. Ковёр уже 0 — вход сразу. Открытое окно — вход не ставить. */
export function chatPushSlideStartOnRelease(args: {
  scrollCancelled: boolean;
  carpetDown: boolean;
}): ChatPushSlideStart {
  if (args.scrollCancelled || !args.carpetDown) return SLIDE_HOLD;
  return { runEnter: true, waitFrames: 0, pushRoute: false };
}

/**
 * Ковёр погашен в этом проходе (cover 0 и listRevealed). Если палец уже поднят,
 * вход не в этом вызове, а на следующем кадре после коммита.
 */
export function chatPushSlideStartOnCarpet(args: {
  playRequested: boolean;
}): ChatPushSlideStart {
  if (!args.playRequested) return SLIDE_HOLD;
  return { runEnter: true, waitFrames: 1, pushRoute: false };
}

/** Показ из maybeConfirmWindowMeasured: окно закрыто высотами и хвост замерён. */
export function shouldRevealMeasuredWindow(args: {
  windowClosedByHeights: boolean;
  threadReady: boolean;
  textMeasuresWarm: boolean;
}): boolean {
  return args.windowClosedByHeights && args.threadReady && args.textMeasuresWarm;
}

/**
 * Монтировать ли FlashList на этом рендере.
 * `mounted` — защёлка: лента, уже попавшая в дерево, остаётся на слайде и на выходе.
 */
export function nextChatListMounted(args: {
  /** Экран за краем, слайд ещё не начат. */
  parked: boolean;
  /** `play` уже вызвал runEnter, progress ещё не дошёл до 1. */
  sliding: boolean;
  /** Взведённый вход без парковки (мгновенный arm). На слайде ленту не начинать. */
  enterArmed: boolean;
  enterProgress: number;
  mounted: boolean;
}): boolean {
  if (args.mounted) return true;
  if (args.parked && !args.sliding) return true;
  if ((args.sliding || args.enterArmed) && args.enterProgress < 1) return false;
  if (args.enterProgress >= 1) return true;
  return false;
}

/**
 * Прятать ленту до показа. Оверлей за краем (скамья и палец) прятать нельзя:
 * opacity 0 не даёт ячейкам снять onLayout и expo-image — bitmap. Ковёр и
 * translate за край держат кадр невидимым, пока высоты и круги не готовы.
 */
export function chatListHiddenUntilReveal(args: {
  listRevealed: boolean;
  overlayHost: boolean;
  preparingWindow: boolean;
  sliding: boolean;
}): boolean {
  if (args.listRevealed) return false;
  if (args.overlayHost && (args.preparingWindow || args.sliding)) return false;
  return true;
}

/**
 * Аргументы `chatListHiddenUntilReveal`, которые передаёт JSX экрана чата.
 * Скамья (`bench`) — тоже окно подготовки: лента рисуется до тапа, а не только
 * под пальцем (`holding`).
 */
export function chatThreadListRevealInput(args: {
  listRevealed: boolean;
  overlayHost: boolean;
  bench: boolean;
  holding: boolean;
  sliding: boolean;
}): {
  listRevealed: boolean;
  overlayHost: boolean;
  preparingWindow: boolean;
  sliding: boolean;
} {
  return {
    listRevealed: args.listRevealed,
    overlayHost: args.overlayHost,
    preparingWindow: args.bench || args.holding,
    sliding: args.sliding,
  };
}

/**
 * scrollTo: shadow node списка уже есть.
 * `0` — пустой view tag (как `if (!tag)` у useScrollOffset).
 */
export function canScrollChatList(shadowNode: unknown): boolean {
  "worklet";
  return shadowNode != null && shadowNode !== 0;
}

/**
 * Ниже порога чат за правым краем. Transform hit-box не двигает, поэтому
 * оверлей с таким progress не должен принимать касания списка.
 */
export const CHAT_PUSH_OFF_EDGE = 0.01;

export function chatPushIsOffEdge(progress: number): boolean {
  "worklet";
  return progress <= CHAT_PUSH_OFF_EDGE;
}

/** Хост оверлея пропускает тапы, пока чат за краем или ещё в парковке. */
export function chatPushHostIgnoresHits(args: { holding: boolean; offEdge: boolean }): boolean {
  return args.holding || args.offEdge;
}

/**
 * Фаза `playing` глотает press, только пока чат ещё на экране.
 * После выхода за край следующий тап снова паркует строку.
 */
export function chatPushPressBlockedByPlay(args: {
  playCommitted: boolean;
  offEdge: boolean;
}): boolean {
  return args.playCommitted && !args.offEdge;
}

export type ChatPushBackAction = "reverse" | "pop-route" | "release" | "keep";

/**
 * Закрытие. Уже идущий выход не перезапускать и не pop-ать список повторно.
 * Оболочка ещё в стеке — pop, даже если `shellPushed` уже сброшен и кадр за
 * краем. «В стеке» не равно `shellPushed`. После pop стека нет — не pop-route.
 * Без оболочки и экран за краем — снять парк, список не pop-ать.
 * Без оболочки и экран ещё виден — обратный слайд от текущего progress.
 */
export function chatPushBackAction(args: {
  shellPushed: boolean;
  /** Маршрут оболочки ещё в стеке. Жест открытия чата этот предикат не зовёт. */
  shellInStack: boolean;
  active: boolean;
  offEdge: boolean;
  exiting: boolean;
}): ChatPushBackAction {
  if (args.exiting) return "keep";
  if (args.shellInStack || args.shellPushed || !args.active) return "pop-route";
  if (args.offEdge) return "release";
  return "reverse";
}

export type ChatPushShellPhase = "idle" | "parked" | "play-wait" | "playing";

/**
 * Снять пустую оболочку. Порог сам маршрут не снимает: только уже начатый
 * выход, кадр ушёл за край вниз, оболочка в фокусе и ещё в стеке.
 * `parked` / `play-wait` — не pop (`parkChatPush` пишет progress = 0).
 * Повтор после снятия маршрута — не второй back.
 */
export function chatPushShellShouldPop(args: {
  exitStarted: boolean;
  phase: ChatPushShellPhase;
  progress: number;
  crossedDown: boolean;
  shellFocused: boolean;
  shellInStack: boolean;
}): boolean {
  if (!args.exitStarted || !args.crossedDown || !args.shellFocused || !args.shellInStack) {
    return false;
  }
  if (args.phase === "parked" || args.phase === "play-wait") return false;
  return chatPushIsOffEdge(args.progress);
}

/** Повторный back в том же выходе не отпускает pop и не режет слайд. */
export function chatPushRepeatBackKeepsIntercept(exitInProgress: boolean): boolean {
  return exitInProgress;
}

/**
 * Сколько окон собирать одновременно, пока список спокоен.
 * Один за раз держал очередь за холодным чатом в голове списка.
 * Больше трёх — уже несколько FlashList в одном кадре прокрутки.
 */
export const CHAT_WARM_PARALLEL = 3;

/**
 * Сколько окон уже в дереве, включая тех, кто отдал слот, но ещё не закрылся.
 * Слот можно отдать раньше закрытия, но без потолка список наберёт FlashList
 * на каждый чат.
 */
export const CHAT_WARM_LIVE_MAX = 5;

/**
 * Сколько слот замера держит место, если окно ещё не закрылось.
 * Экран остаётся и может закрыться позже. Иначе один холодный чат
 * держит пачку до дедлайна показа.
 */
export const CHAT_WARM_SLOT_MS = 400;

/**
 * Сколько раз yielded-чат с тёплым хвостом снова получает слот. Окно, которое
 * не закрылось за столько дедлайнов, держит что-то структурное (расшифровка
 * заблокирована, ростер группы не пришёл) — дальше его не трогаем.
 */
export const CHAT_WARM_RETRY_MAX = 2;

/**
 * Пауза между посадкой треда (оболочка запушена) и следующей пачкой скамьи.
 * Открытый чат сразу после слайда доклеивает окно (+150 мс) и отпускает
 * волны расшифровки (+400 мс) — коммиты скамьи идут после них.
 */
export const CHAT_WARM_THREAD_SETTLE_MS = 600;

/**
 * Кого сейчас собирать. Уже начатые не снимать. Свободные слоты сначала
 * отдают чатам с расшифрованным хвостом. Холодный замер не занимает слот,
 * пока такой чат ещё ждёт, и не стартует, пока хоть одно такое окно не
 * закрыто. Страница без расшифровки (`heldIds`) слот не берёт: её добьёт
 * лёгкий прогрев. Слайд на экране новых не добавляет. Палец занимает слот.
 * Yielded-чаты из `retryIds` с тёплым хвостом берут только оставшиеся слоты
 * — после всех, кто ещё не пробовал.
 */
export function selectChatWarmMeasureIds(args: {
  order: readonly string[];
  cachedIds: readonly string[];
  closedIds: readonly string[];
  yieldedIds: readonly string[];
  inFlightIds: readonly string[];
  slideBusy: boolean;
  assemblyEnabled: boolean;
  parkedMeasuringId: string | null;
  allowUncached?: boolean;
  /** Страница уже есть, хвост ещё нет. Не монтировать как холодный чат. */
  heldIds?: readonly string[];
  /**
   * Yielded-чаты, которым ещё можно вернуть слот (дедлайн не исчерпан).
   * Берутся только с тёплым хвостом (`cachedIds`) и только в свободные места.
   */
  retryIds?: readonly string[];
  limit?: number;
}): string[] {
  const limit = args.limit ?? CHAT_WARM_PARALLEL;
  const closed = new Set(args.closedIds);
  if (args.slideBusy) {
    return args.inFlightIds.filter((id) => !closed.has(id));
  }
  const yielded = new Set(args.yieldedIds);
  const cached = new Set(args.cachedIds);
  const held = new Set(args.heldIds ?? []);
  const retry = new Set(args.retryIds ?? []);
  const inFlight = new Set(args.inFlightIds);
  let cachedWaiting = false;
  let cachedOpen = false;
  for (const id of args.order) {
    if (!cached.has(id) || closed.has(id)) continue;
    cachedOpen = true;
    if (yielded.has(id) || inFlight.has(id)) continue;
    cachedWaiting = true;
  }
  const chosen: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null, allowYielded = false) => {
    if (!id || seen.has(id) || closed.has(id)) return;
    if (yielded.has(id) && !allowYielded) return;
    const reserved = id === args.parkedMeasuringId;
    if (chosen.length >= limit && !reserved) return;
    seen.add(id);
    chosen.push(id);
  };
  for (const id of args.inFlightIds) {
    if (cachedWaiting && !cached.has(id) && id !== args.parkedMeasuringId) continue;
    add(id);
  }
  if (args.parkedMeasuringId) add(args.parkedMeasuringId);
  if (!args.assemblyEnabled && args.parkedMeasuringId == null) return chosen;
  for (const id of args.order) {
    if (cached.has(id)) add(id);
  }
  if (args.allowUncached !== false && !cachedOpen) {
    for (const id of args.order) {
      if (held.has(id)) continue;
      add(id);
    }
  }
  if (args.assemblyEnabled) {
    // Промах дедлайна не вычёркивает чат на всю сессию: тёплый хвост снова
    // берёт слот, когда очередь свободна. Холодный yielded ждёт свою страницу.
    for (const id of args.order) {
      if (retry.has(id) && yielded.has(id) && cached.has(id)) add(id, true);
    }
  }
  return chosen;
}

/**
 * Хост скамьи над списком, пока слайд ещё виден. Пока палец держит слот, а
 * его окно не закрыто, хост остаётся под списком: иначе слот замера уезжает
 * за край и новых onLayout нет. `enterPaint` и `exiting` поднимают хост и
 * при открытом ковре. `offEdge` раньше конца выхода влияет только на хиты:
 * картинка остаётся сверху, пока `exiting`. После progress = 0 и снятого
 * exiting хост снова под списком. Смена — разовая, не на кадр жеста.
 */
export function chatBenchHostRaised(args: {
  holding: boolean;
  offEdge: boolean;
  exiting: boolean;
  enterPaint: boolean;
  /**
   * Ковёр активного слота погашен. Нет аргумента — считаем погашенным:
   * прежние вызовы по-прежнему поднимают хост на holding.
   */
  carpetDown?: boolean;
}): boolean {
  if (args.exiting || args.enterPaint) return true;
  if (args.holding && args.carpetDown === false) return false;
  return args.holding || !args.offEdge;
}

/**
 * Первое отпускание прогретого чата. Публикация фазы — до withTiming, слот
 * ещё за правым краем; тайминг — следующий кадр. На `completeParkedEnter`
 * эту публикацию не переносить: слот остаётся в hold и runEnter с этого
 * отпускания не стартует.
 */
export function chatPushEnterKickoff(args: {
  scrollCancelled: boolean;
  carpetDown: boolean;
}): {
  runEnter: boolean;
  publishBeforeTiming: boolean;
  timingNextFrame: boolean;
  deferPublishToComplete: false;
} {
  const start = chatPushSlideStartOnRelease(args);
  if (!start.runEnter) {
    return {
      runEnter: false,
      publishBeforeTiming: false,
      timingNextFrame: false,
      deferPublishToComplete: false,
    };
  }
  return {
    runEnter: true,
    publishBeforeTiming: true,
    timingNextFrame: true,
    deferPublishToComplete: false,
  };
}

/**
 * Запись off-edge на пороге 0.01 во время withTiming заезда флаг пишет,
 * подписчиков не будит. Выход (кадр ушёл за край) по-прежнему публикует хиты.
 */
export function chatPushOffEdgeNotifies(args: {
  prevOff: boolean;
  nextOff: boolean;
  enterTiming: boolean;
}): boolean {
  if (args.prevOff === args.nextOff) return false;
  if (args.enterTiming && args.prevOff && !args.nextOff) return false;
  return true;
}

/**
 * Решение реакции таб-бара. Заезд через 0.01 не коммитит `chatOffEdge`.
 * Падение до <= 0.01 коммитит `offEdge = true`. Снятие обратной ветки
 * красит тест: функция перестаёт возвращать true на падении.
 */
export function chatPushTabBarOffEdgeCommit(prev: number | null, progress: number): boolean {
  "worklet";
  if (prev == null) return false;
  const off = progress <= CHAT_PUSH_OFF_EDGE;
  const wasOff = prev <= CHAT_PUSH_OFF_EDGE;
  if (wasOff && !off) return false;
  return !wasOff && off;
}

export type ChatBenchSlotLayer = "measure" | "parked" | "active";

export type ChatBenchSlotFrame = {
  id: string;
  layer: ChatBenchSlotLayer;
  /** Другой слот в кадре замера лежит поверх: onLayout и onLoad сюда не дойдут. */
  occluded: boolean;
  /** Поза не меняет инстанс ленты. */
  remount: false;
};

/**
 * Один слот в кадре замера — последний, без соседа поверх. Закрытые и
 * ожидающие остаются в дереве, но не в этом кадре. Хост под списком и
 * активный слот ещё не закрыт — кадр замера у него (`measure`, не `active`),
 * сосед в окно не попадает. Пока хост поднят, кадра замера нет: закрытый
 * активный слот последний и до runEnter стоит за краем.
 */
export function layoutChatBenchSlots(args: {
  slots: readonly { id: string; closed: boolean }[];
  activeId: string | null;
  hostRaised: boolean;
}): ChatBenchSlotFrame[] {
  const active =
    args.activeId == null ? undefined : args.slots.find((slot) => slot.id === args.activeId);
  const measureOpenActive = !args.hostRaised && active != null && !active.closed;
  const measureId = args.hostRaised
    ? null
    : measureOpenActive
      ? active.id
      : (args.slots.find((slot) => !slot.closed && slot.id !== args.activeId)?.id ?? null);
  const topId = args.hostRaised ? args.activeId : measureId;
  const rest = args.slots.filter((slot) => slot.id !== topId);
  const top = topId == null ? [] : args.slots.filter((slot) => slot.id === topId);
  const ordered = [...rest, ...top];
  return ordered.map((slot, index) => {
    const layer: ChatBenchSlotLayer =
      slot.id === measureId ? "measure" : slot.id === args.activeId ? "active" : "parked";
    const occluded = ordered.slice(index + 1).some((above) => above.id === measureId);
    return { id: slot.id, layer, occluded, remount: false };
  });
}

/**
 * `null` — нет translateX, слот в окне. Закрытый слот и активный до runEnter
 * (`slideProgress` 0 при driven) — `screenWidth`. Слайд читает progress.
 */
export function chatBenchSlotTranslateX(args: {
  measureFrame: boolean;
  slideOwned: boolean;
  slideDriven: boolean;
  slideProgress: number;
  screenWidth: number;
}): number | null {
  "worklet";
  if (args.measureFrame && !args.slideOwned) return null;
  if (!args.slideOwned) return args.screenWidth;
  if (!args.slideDriven) return 0;
  return (1 - args.slideProgress) * args.screenWidth;
}

/** bench → active не сбрасывает показ и не ждёт второй reveal. */
export function chatBenchPromoteKeepsReveal(listRevealed: boolean): boolean {
  return listRevealed;
}

/**
 * Какие треды держать смонтированными. Закрытое окно не снимать: повторный
 * монтаж снова открывает ковёр и мигает аватары списка. Активный и текущий
 * замер — тоже в дереве, даже если их ещё нет в порядке списка.
 */
export function chatWarmMountedIds(args: {
  order: readonly string[];
  startedIds: readonly string[];
  measuringId: string | null;
  activeId: string | null;
}): string[] {
  const started = new Set(args.startedIds);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of args.order) {
    if (started.has(id) || id === args.measuringId || id === args.activeId) add(id);
  }
  add(args.measuringId);
  add(args.activeId);
  return out;
}
