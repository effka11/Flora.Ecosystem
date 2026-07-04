// SDK 56: без прямого импорта из @react-navigation/native — локальные типы state.

type TabNavigatorState = {
  type?: string;
  index?: number;
  routes?: ReadonlyArray<{ key?: string }>;
};

type NavigationStateLike = {
  type?: string;
  index?: number;
  routes?: ReadonlyArray<{ key?: string; state?: TabNavigatorState }>;
};

function activeKeyFromTabState(tabState: TabNavigatorState | undefined): string | undefined {
  if (tabState?.type !== "tab" || !tabState.routes?.length) {
    return undefined;
  }
  const index = typeof tabState.index === "number" ? tabState.index : 0;
  return tabState.routes[index]?.key;
}

/** Ключ активной вкладки Tab navigator — из корневого Stack (экран `(tabs)`) или из tab state напрямую. */
export function getActiveTabRouteKey(state: NavigationStateLike | undefined): string | undefined {
  if (!state) {
    return undefined;
  }

  const direct = activeKeyFromTabState(state);
  if (direct) {
    return direct;
  }

  const focusedRoute = state.routes?.[typeof state.index === "number" ? state.index : 0];
  return activeKeyFromTabState(focusedRoute?.state);
}

/** Индекс сегмента активной вкладки в `useSegments()` — сразу после `(tabs)`. */
export function tabSegmentIndex(segments: readonly string[]): number {
  const tabsIdx = segments.indexOf("(tabs)");
  return tabsIdx >= 0 ? tabsIdx + 1 : 0;
}

export function getActiveTabSegment(segments: readonly string[]): string | undefined {
  return segments[tabSegmentIndex(segments)];
}

/** Вкладка `tabName` уже выбрана в tab bar (не переход с другой вкладки). */
export function isTabActive(segments: readonly string[], tabName: string): boolean {
  return getActiveTabSegment(segments) === tabName;
}

/**
 * Корень вкладки — активная вкладка `tabName` без вложенных маршрутов.
 * `index` считается корнем (expo-router иногда добавляет его в segments).
 */
export function isTabRoot(segments: readonly string[], tabName: string): boolean {
  const idx = tabSegmentIndex(segments);
  if (segments[idx] !== tabName) {
    return false;
  }
  const nested = segments.slice(idx + 1);
  return nested.length === 0 || (nested.length === 1 && nested[0] === "index");
}
