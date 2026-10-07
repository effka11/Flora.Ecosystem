/**
 * Разрешение очереди скамьи брать новые окна (`setChatWarmAssemblyEnabled`).
 *
 * Пуш треда снимает фокус со списка, но вкладку Messages не покидает: хост
 * скамьи живёт в лэйауте вкладки, и пока открытый чат стоит на экране,
 * следующие окна собираются дальше. Сборку гасит только уход с вкладки —
 * ни один её экран (список, оболочка треда) не в фокусе — и движение: скролл
 * списка (реестр scrollActivity) или скролл открытого треда. Слайд и выход
 * очередь глушит сама (`slideOccupiesWarm` в chatPushTransition).
 *
 * Выключение — сразу: коммит FlashList не должен попасть в начавшийся жест.
 * Включение — отложенно (`schedule`): blur списка и focus оболочки идут в
 * одном переходе, а сборка не делит кадр с пушем маршрута и добором свежести.
 * Без RN: экраны подставляют фокус и фазы скролла, чистая часть тестируется.
 */

export function chatWarmAssemblyAllowed(args: {
  focusedScreens: number;
  scrollBusyOwners: number;
}): boolean {
  return args.focusedScreens > 0 && args.scrollBusyOwners === 0;
}

export type ChatWarmAssemblyGate = {
  /** Экран вкладки в фокусе. `settleMs` — пауза перед включением (0 — ближайший кадр). */
  setScreenFocused(owner: symbol, focused: boolean, settleMs?: number): void;
  /** Список или открытый тред в движении. */
  setScrollBusy(owner: symbol, busy: boolean): void;
  /** Unmount экрана: снять обе отметки владельца. */
  clearOwner(owner: symbol): void;
  /** Что очередь видит сейчас (после отложенного включения). */
  applied(): boolean;
  /** Расчёт по текущим входам, без задержки. */
  allowed(): boolean;
};

export function createChatWarmAssemblyGate(deps: {
  apply: (enabled: boolean) => void;
  /** Отложить включение на `settleMs` (0 — следующий кадр); вернуть отмену. */
  schedule: (run: () => void, settleMs: number) => () => void;
}): ChatWarmAssemblyGate {
  const focused = new Set<symbol>();
  const busy = new Set<symbol>();
  let applied = false;
  let cancelPending: (() => void) | null = null;

  const allowed = () =>
    chatWarmAssemblyAllowed({ focusedScreens: focused.size, scrollBusyOwners: busy.size });

  function sync(settleMs: number): void {
    if (!allowed()) {
      cancelPending?.();
      cancelPending = null;
      if (applied) {
        applied = false;
        deps.apply(false);
      }
      return;
    }
    if (applied || cancelPending) return;
    cancelPending = deps.schedule(() => {
      cancelPending = null;
      if (applied || !allowed()) return;
      applied = true;
      deps.apply(true);
    }, settleMs);
  }

  return {
    setScreenFocused(owner, isFocused, settleMs = 0) {
      if (isFocused) focused.add(owner);
      else focused.delete(owner);
      sync(settleMs);
    },
    setScrollBusy(owner, isBusy) {
      if (isBusy) busy.add(owner);
      else busy.delete(owner);
      sync(0);
    },
    clearOwner(owner) {
      focused.delete(owner);
      busy.delete(owner);
      sync(0);
    },
    applied: () => applied,
    allowed,
  };
}

/** Короткий бросок без `onMomentumScrollBegin`: флаг снимает таймер. */
export const THREAD_SCROLL_COAST_FALLBACK_MS = 240;

export type ScrollBusyTracker = {
  beginDrag(): void;
  /** `velocity` — скорость на отпускании; ~0 — инерции не будет. */
  endDrag(velocity: number): void;
  momentumBegin(): void;
  momentumEnd(): void;
  dispose(): void;
};

/**
 * Фазы скролла одного списка → один флаг «занят». Отпускание с инерцией
 * держит флаг до `momentumEnd`; если `momentumBegin` так и не пришёл,
 * страховочный таймер отпускает сам. Снятие флага идемпотентно.
 */
export function createScrollBusyTracker(deps: {
  setBusy: (busy: boolean) => void;
  schedule: (run: () => void, ms: number) => () => void;
  coastFallbackMs?: number;
}): ScrollBusyTracker {
  const coastFallbackMs = deps.coastFallbackMs ?? THREAD_SCROLL_COAST_FALLBACK_MS;
  let busy = false;
  let cancelFallback: (() => void) | null = null;

  function set(next: boolean): void {
    if (busy === next) return;
    busy = next;
    deps.setBusy(next);
  }

  function clearFallback(): void {
    cancelFallback?.();
    cancelFallback = null;
  }

  return {
    beginDrag() {
      clearFallback();
      set(true);
    },
    endDrag(velocity) {
      clearFallback();
      if (Math.abs(velocity) <= 0.01) {
        set(false);
        return;
      }
      cancelFallback = deps.schedule(() => {
        cancelFallback = null;
        set(false);
      }, coastFallbackMs);
    },
    momentumBegin() {
      clearFallback();
      set(true);
    },
    momentumEnd() {
      clearFallback();
      set(false);
    },
    dispose() {
      clearFallback();
      set(false);
    },
  };
}
