import { floraTabBarHiddenStyle, floraTabBarStyle } from "@/lib/theme";

// SDK 56: expo-router запрещает прямой импорт из @react-navigation/native.
// Локально воспроизводим getFocusedRouteNameFromRoute (имя активного дочернего
// маршрута на один уровень вложенности) без зависимости от react-navigation.
type NestedRouteState = {
  index?: number;
  routes?: ReadonlyArray<{ name?: string }>;
};
type FocusableRoute = {
  state?: NestedRouteState;
  params?: { screen?: unknown };
};

function focusedChildRouteName(route: FocusableRoute | undefined): string | undefined {
  const state = route?.state;
  if (state?.routes && state.routes.length > 0) {
    const index = typeof state.index === "number" ? state.index : 0;
    return state.routes[index]?.name;
  }
  const screen = route?.params?.screen;
  return typeof screen === "string" ? screen : undefined;
}

/** Tab bar для вкладки «Сообщения»: скрыт внутри треда, виден на списке диалогов. */
export function messagesTabBarStyleForRoute(
  route: FocusableRoute | undefined,
  bottomInset: number,
) {
  const routeName = focusedChildRouteName(route) ?? "index";
  const inThread = routeName !== "index";
  return inThread ? floraTabBarHiddenStyle(bottomInset) : floraTabBarStyle(bottomInset);
}

export function applyMessagesTabBarHidden(
  navigation: { getParent: () => { setOptions: (o: object) => void } | undefined },
  bottomInset: number,
  hidden: boolean,
): void {
  navigation.getParent()?.setOptions({
    tabBarStyle: hidden ? floraTabBarHiddenStyle(bottomInset) : floraTabBarStyle(bottomInset),
  });
}
