export type GovNavStatus = "live" | "static" | "shell";

export type GovNavItem = {
  readonly href: string;
  readonly label: string;
  readonly status: GovNavStatus;
};

/** Вкладки шапки — только живой срез; 1:1 пара как в ленте Social. */
export const GOV_NAV_ITEMS: readonly GovNavItem[] = [
  { href: "/overview", label: "Обзор", status: "static" },
  { href: "/moderation", label: "Модерация", status: "live" },
];

/** Все civic-маршруты (вкладки + оболочки вне шапки). */
export const GOV_PAGE_ITEMS: readonly GovNavItem[] = [
  ...GOV_NAV_ITEMS,
  { href: "/constitution", label: "Конституция", status: "static" },
  { href: "/journal", label: "Журнал", status: "shell" },
  { href: "/proposals", label: "Предложения", status: "shell" },
  { href: "/sortition", label: "Жребий", status: "shell" },
  { href: "/treasury", label: "Казна", status: "shell" },
  { href: "/circles", label: "Круги", status: "shell" },
];
