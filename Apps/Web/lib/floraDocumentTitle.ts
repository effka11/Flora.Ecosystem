export const FLORA_DOCUMENT_TITLE = "Flora";

/**
 * Разделитель во вкладке. Обычные пробелы браузер схлопывает в `<title>`,
 * поэтому два неразрывных с каждой стороны (`\u00A0`).
 */
export const FLORA_TITLE_SEPARATOR = "\u00A0\u00A0–\u00A0\u00A0";

/** Единый формат вкладки: `Flora  –  Сообщения`. */
export function formatFloraDocumentTitle(pageTitle: string): string {
  const trimmed = pageTitle.trim();
  if (!trimmed) return FLORA_DOCUMENT_TITLE;
  return `${FLORA_DOCUMENT_TITLE}${FLORA_TITLE_SEPARATOR}${trimmed}`;
}

/** SSR metadata segment — root `title.template` wraps it as `Flora  –  …`. */
export function floraPageMetadata(pageTitle: string): { title: string } {
  return { title: pageTitle.trim() };
}

/** Статический заголовок по pathname (без данных с API). */
export function resolveFloraDocumentTitle(pathname: string): string {
  const path = pathname.replace(/\/$/, "") || "/";

  switch (path) {
    case "/":
    case "/login":
      return formatFloraDocumentTitle("Вход");
    case "/rules":
      return formatFloraDocumentTitle("Правила сообщества");
    case "/feed":
      return formatFloraDocumentTitle("Главная");
    case "/messages":
      return formatFloraDocumentTitle("Сообщения");
    case "/people":
      return formatFloraDocumentTitle("Люди");
    case "/communities":
      return formatFloraDocumentTitle("Сообщества");
    case "/communities/own":
      return formatFloraDocumentTitle("Мои сообщества");
    case "/notifications":
      return formatFloraDocumentTitle("Уведомления");
    case "/settings":
      return formatFloraDocumentTitle("Настройки");
    case "/profile":
      return formatFloraDocumentTitle("Профиль");
    case "/compose":
    case "/feed/compose":
      return formatFloraDocumentTitle("Создать пост");
    case "/music":
      return formatFloraDocumentTitle("Музыка");
    default:
      break;
  }

  if (path.startsWith("/profile/")) {
    return formatFloraDocumentTitle("Профиль");
  }
  if (/\/communities\/[^/]+\/settings$/.test(path)) {
    return formatFloraDocumentTitle("Настройки сообщества");
  }
  if (path.startsWith("/communities/")) {
    return formatFloraDocumentTitle("Сообщество");
  }
  if (path.startsWith("/music/artist/")) {
    return formatFloraDocumentTitle("Артист");
  }
  if (path.startsWith("/music/playlist/")) {
    return formatFloraDocumentTitle("Плейлист");
  }
  if (path.startsWith("/music/genre/")) {
    return formatFloraDocumentTitle("Жанр");
  }

  return FLORA_DOCUMENT_TITLE;
}
