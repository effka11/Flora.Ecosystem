/**
 * Дев-замер открытия чата: тормозит — мерить, не гадать.
 *
 * Одна трасса за раз: тап по строке списка → mount экрана треда → data
 * (FlashList получил непустые данные) → ready (окно расшифровки терминально)
 * → cell (первый renderItem) → load (фактические высоты ячеек закрыли
 * вьюпорт от якоря — наш детерминированный «onLoad», см.
 * maybeConfirmWindowMeasured; onLoad самого FlashList срабатывает раньше
 * монтажа реально видимых строк) → reveal (первый видимый кадр ленты).
 * Одна строка лога на reveal, в проде — no-op.
 */

type ChatOpenStage = "render" | "mount" | "data" | "ready" | "cell" | "load" | "reveal";

let tapAt: number | null = null;
let tracedUuid: string | null = null;
let stages: Partial<Record<ChatOpenStage, number>> = {};
let layoutWarm: string | null = null;
let cellRenders = 0;
let screenRenders = 0;

export function markChatOpenTap(conversationUuid: string): void {
  if (!__DEV__) return;
  tapAt = Date.now();
  tracedUuid = conversationUuid.trim().toLowerCase();
  stages = {};
  layoutWarm = null;
  cellRenders = 0;
  screenRenders = 0;
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
    `[chat-open] render=${stages.render ?? "?"}ms mount=${stages.mount ?? "?"}ms ` +
      `data=${stages.data ?? "?"}ms ready=${stages.ready ?? "?"}ms ` +
      `cell=${stages.cell ?? "?"}ms load=${stages.load ?? "?"}ms ` +
      `reveal=${stages.reveal}ms cells=${cellRenders} renders=${screenRenders} ` +
      `layout-прогрет=${layoutWarm ?? "?"} (от тапа)`,
  );
  tapAt = null;
  tracedUuid = null;
  layoutWarm = null;
  cellRenders = 0;
  screenRenders = 0;
}
