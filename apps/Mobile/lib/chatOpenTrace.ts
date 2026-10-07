/**
 * Дев-замер открытия чата: тормозит — мерить, не гадать.
 *
 * Одна трасса за раз: парковка (press-in) → mount экрана треда → data
 * (FlashList получил непустые данные) → ready (окно расшифровки терминально)
 * → cell (первый renderItem) → load (фактические высоты ячеек закрыли
 * вьюпорт от якоря — наш детерминированный «onLoad», см.
 * maybeConfirmWindowMeasured; onLoad самого FlashList срабатывает раньше
 * монтажа реально видимых строк) → play (старт runEnter) → reveal.
 * Тап ту же трассу не обнуляет: cell и load парковки остаются и сравниваются
 * с play. Одна строка лога на reveal, в проде — no-op.
 */

type ChatOpenStage = "render" | "mount" | "data" | "ready" | "cell" | "load" | "play" | "reveal";

let tapAt: number | null = null;
let tracedUuid: string | null = null;
let stages: Partial<Record<ChatOpenStage, number>> = {};
let layoutWarm: string | null = null;
let cellRenders = 0;
let screenRenders = 0;
/** Снимок тёплого пути на этом открытии. В строку reveal попадает последний. */
let warmLine: string | null = null;
/** Кто показал ленту: тёплый коммит, холодный цикл якоря или потолок кадров. */
let revealPath: "warm" | "cold" | "deadline" | null = null;

function beginChatOpenTrace(uuid: string): void {
  tapAt = Date.now();
  tracedUuid = uuid;
  stages = {};
  layoutWarm = null;
  cellRenders = 0;
  screenRenders = 0;
  warmLine = null;
  revealPath = null;
}

const benchClosedLogged = new Set<string>();

/**
 * Скамья закрыла окно до тапа. Строка пишется сразу, не в трассе пальца:
 * `markChatOpenPark` на press-in её уже не обгоняет.
 * `warm=0` — сработал потолок bitmap, показ отпущен, открытие не тёплое.
 */
export function noteChatBenchWindowClosed(conversationUuid: string, warm: boolean): void {
  if (!__DEV__) return;
  const uuid = conversationUuid.trim().toLowerCase();
  if (!uuid || benchClosedLogged.has(uuid)) return;
  benchClosedLogged.add(uuid);
  console.log(`[chat-open] bench-close ${uuid} warm=${warm ? 1 : 0}`);
}

/** Старт трассы на press-in. Повтор того же uuid трассу не сбрасывает. */
export function markChatOpenPark(conversationUuid: string): void {
  if (!__DEV__) return;
  const uuid = conversationUuid.trim().toLowerCase();
  if (!uuid) return;
  if (tapAt != null && tracedUuid === uuid) return;
  beginChatOpenTrace(uuid);
}

/**
 * Тап. Если парковка этого uuid уже ведёт трассу — не обнулять:
 * cell и load должны остаться раньше play.
 */
export function markChatOpenTap(conversationUuid: string): void {
  if (!__DEV__) return;
  const uuid = conversationUuid.trim().toLowerCase();
  if (!uuid) return;
  if (tapAt != null && tracedUuid === uuid) return;
  beginChatOpenTrace(uuid);
}

/** Старт runEnter. Повтор не затирает первую метку. */
export function markChatOpenPlay(): void {
  if (!__DEV__ || tapAt == null || tracedUuid == null) return;
  markChatOpenStage("play", tracedUuid);
}

/**
 * Решение тёплого показа. Пишется сразу, не дожидаясь reveal: если лента
 * остаётся тёмной, в логе уже есть, какого кэша не хватило.
 */
export function noteChatOpenWarmCheck(conversationUuid: string, line: string): void {
  if (!__DEV__) return;
  const uuid = conversationUuid.trim().toLowerCase();
  if (tapAt != null && tracedUuid != null && uuid !== tracedUuid) return;
  warmLine = line;
  const at = tapAt == null ? "?" : String(Date.now() - tapAt);
  console.log(`[chat-open] warm +${at}ms ${line}`);
}

/**
 * Путь показа. `warm` не перебивается. `deadline` заменяет `cold`.
 * `cold` пишется только если путь ещё не выбран.
 */
export function noteChatOpenRevealPath(path: "warm" | "cold" | "deadline"): void {
  if (!__DEV__ || tapAt == null) return;
  if (revealPath === "warm") return;
  if (path === "cold" && revealPath != null) return;
  revealPath = path;
}

/**
 * Доля строк окна показа, чья раскладка текста была прогрета заранее
 * (offscreen-замер). Низкое значение = пузыри будут «допрыгивать»: прогрев не
 * успел или ключ замера не совпал с тем, что просит лента.
 */
export function noteChatOpenLayoutWarm(hits: number, total: number): void {
  if (!__DEV__ || tapAt == null) return;
  if (layoutWarm != null) return;
  layoutWarm = `${hits}/${total}`;
}

/** Счётчик вызовов renderItem до показа: сколько ячеек реально рендерилось. */
export function noteChatOpenCellRender(conversationUuid: string): void {
  if (!__DEV__ || tapAt == null) return;
  if (conversationUuid.trim().toLowerCase() !== tracedUuid) return;
  cellRenders += 1;
  markChatOpenStage("cell", conversationUuid);
}

/** Счётчик рендеров всего экрана треда до показа. */
export function noteChatOpenScreenRender(conversationUuid: string): void {
  if (!__DEV__ || tapAt == null) return;
  if (conversationUuid.trim().toLowerCase() !== tracedUuid) return;
  screenRenders += 1;
  // Первый рендер экрана с новым uuid: tap→render — цена роутера и
  // ре-рендера дерева навигаторов, render→mount — рендер и коммит экрана.
  markChatOpenStage("render", conversationUuid);
}

export function markChatOpenStage(stage: ChatOpenStage, conversationUuid: string): void {
  if (!__DEV__ || tapAt == null) return;
  if (conversationUuid.trim().toLowerCase() !== tracedUuid) return;
  if (stages[stage] != null) return;
  stages[stage] = Date.now() - tapAt;
  if (stage !== "reveal") return;
  console.log(
    `[chat-open] path=${revealPath ?? "?"} ` +
      `render=${stages.render ?? "?"}ms mount=${stages.mount ?? "?"}ms ` +
      `data=${stages.data ?? "?"}ms ready=${stages.ready ?? "?"}ms ` +
      `cell=${stages.cell ?? "?"}ms load=${stages.load ?? "?"}ms ` +
      `play=${stages.play ?? "?"}ms ` +
      `reveal=${stages.reveal}ms cells=${cellRenders} renders=${screenRenders} ` +
      `layout-прогрет=${layoutWarm ?? "?"} ${warmLine ?? "warm=?"} (от тапа)`,
  );
  tapAt = null;
  tracedUuid = null;
  layoutWarm = null;
  cellRenders = 0;
  screenRenders = 0;
  warmLine = null;
  revealPath = null;
}
