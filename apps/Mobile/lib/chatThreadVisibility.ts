/**
 * Решения видимости треда, которые обязаны переживать activity-pause.
 *
 * Системный пикер фото — отдельная activity: приложение может быть
 * приостановлено ровно в кадр монтажа/показа треда. Reanimated-ворклеты,
 * `runOnJS`-колбэки и завершения `withTiming` через такой переход не
 * гарантированы. Всё, что держит ленту видимой (ковёр входа, reveal-цикл,
 * поверхность push-перехода), не имеет права оставаться односторонней
 * защёлкой UI-потока: у каждого такого состояния должен быть JS-путь
 * восстановления.
 */

/**
 * Потолок ожидания показа: после него лента показывается JS-путём
 * (`revealListNow`), даже если UI-цикл показа потерялся в activity-переходе.
 * Больше обычного цикла (60 кадров) с запасом на медленный старт.
 */
export const LIST_REVEAL_WATCHDOG_MS = 2000;
/** Запас к окну фейда ковра: страховка на потерянный `withTiming`. */
export const ENTER_COVER_UNMOUNT_MARGIN_MS = 120;
/**
 * Сколько открытому треду ждать прогресс push-перехода, прежде чем вернуть
 * поверхность в кадр принудительно (потерянный driven/анимация входа).
 */
export const CHAT_SURFACE_REPAIR_WATCHDOG_MS = 320;
/**
 * Сколько открытому треду ждать защёлку монтажа ленты. Нормальный вход
 * закрывает её реакцией на progress = 1; потерянная реакция не имеет права
 * оставить тред без FlashList до переоткрытия чата.
 */
export const CHAT_LIST_MOUNT_WATCHDOG_MS = 700;

/**
 * Показ не состоялся, хотя цикл показа уже запущен: watchdog обязан
 * показать ленту из JS. `revealed` проверяется на момент срабатывания.
 */
export function shouldRecoverReveal(args: {
  revealStarted: boolean;
  revealed: boolean;
}): boolean {
  return args.revealStarted && !args.revealed;
}

/**
 * Ковёр входа снимается с дерева после окна фейда. У живого, уже показанного
 * треда непрозрачный ковёр — только баг (потерянный `withTiming`), поэтому
 * страховочный таймер обязан его убрать.
 */
export function shouldUnmountEnterCover(revealed: boolean): boolean {
  return revealed;
}

/**
 * Маршрут треда открыт и не выходит, а progress так и остался за краем:
 * внешний сброс (фокус списка после activity) или потерянная анимация входа.
 * Поверхность нужно вернуть в кадр даже при застрявшем `driven`.
 */
export function shouldForceChatSurfaceOpen(args: {
  surfaceOpen: boolean;
  offEdge: boolean;
  exiting: boolean;
}): boolean {
  return args.surfaceOpen && args.offEdge && !args.exiting;
}

/** Поверхность открыта, а лента так и не смонтировалась — открываем защёлку из JS. */
export function shouldForceChatListMount(args: {
  surfaceOpen: boolean;
  listMounted: boolean;
}): boolean {
  return args.surfaceOpen && !args.listMounted;
}
