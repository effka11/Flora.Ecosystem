/**
 * Системный пикер фото на экране + отложенные разрушительные переходы.
 *
 * Пикер — отдельная Android-activity: пока он открыт, наше activity в фоне.
 * Любой `router.back()` / `replace` в этом окне исполняется под пикером, и на
 * возврате пользователь видит не чат, а список диалогов — «выбросило из чата
 * при выборе фото». Поэтому разрушительные переходы поверхности (снятие
 * оболочки треда, выход из удалённого/закрытого чата) не выполняются, пока
 * пикер впереди: решение откладывается до конца обработки его результата.
 *
 * Слот отложенного перехода один: все такие решения ведут к одному —
 * «уйти из треда», и последнее из них самое свежее.
 */
let picking = false;
let deferredExit: (() => void) | null = null;

/**
 * Пикер, который так и не отдал результат (потерянный activity-result при
 * пересоздании activity), не имеет права оставить кнопку «+» мёртвой до
 * перезапуска приложения.
 */
export const CHAT_PICK_ACTIVITY_STUCK_MS = 120_000;

export function beginChatPickActivity(): void {
  picking = true;
}

export function isChatPickActivityActive(): boolean {
  return picking;
}

/**
 * Выполнить переход сразу или после возврата из пикера. Немедленный путь —
 * синхронный: вызывающие полагаются на порядок (сначала снять маршрут, потом
 * public-состояние).
 */
export function runAfterChatPickActivity(run: () => void): void {
  if (!picking) {
    run();
    return;
  }
  deferredExit = run;
}

export function endChatPickActivity(): void {
  picking = false;
  const run = deferredExit;
  deferredExit = null;
  run?.();
}

/**
 * Пикер не отдал результат: флаг снимается, отложенный выход отбрасывается.
 * Навигация под возможно ещё открытым пикером опаснее потери одного выхода:
 * пользователь видит чат и может выйти сам.
 */
export function abandonChatPickActivity(): void {
  picking = false;
  deferredExit = null;
}

/** Сброс модульного состояния между тестами. */
export function resetChatPickActivityForTests(): void {
  picking = false;
  deferredExit = null;
}
