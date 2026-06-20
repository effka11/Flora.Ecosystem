function normalizedHandle(username: string): string {
  return username.trim().replace(/^@+/, "");
}

/** Ник из API непригоден для показа (пусто, один символ, только «_»). */
function isRenderableUsername(username: string): boolean {
  const u = normalizedHandle(username);
  if (u.length < 2) return false;
  if (/^_+$/.test(u)) return false;
  return true;
}

/** Единый формат @ник в UI. */
export function formatAtHandle(username: string): string {
  if (!isRenderableUsername(username)) return "@…";
  return `@${normalizedHandle(username)}`;
}

/** Имя в шапке: display_name из профиля или ник, если имени нет. */
export function profileDisplayName(displayName: string, username: string): string {
  const d = displayName.trim();
  if (d.length > 0) return d;
  if (isRenderableUsername(username)) return normalizedHandle(username);
  return "Профиль";
}

/** Две буквы для аватара: из имени или из ника. */
export { profileInitials } from "@flora/client-core/display";

/** Путь публичного профиля в дашборде (`/profile/{slug}`). */
export function profilePathFromUsername(username: string): string {
  const slug = normalizedHandle(username);
  return `/profile/${encodeURIComponent(slug || "user")}`;
}

/** Сравнение с текущим ником (без учёта регистра и ведущего @). */
export function handlesEqual(a: string, b: string): boolean {
  const na = a.trim().replace(/^@+/, "").toLowerCase();
  const nb = b.trim().replace(/^@+/, "").toLowerCase();
  if (na.length < 2 || nb.length < 2) return false;
  if (/^_+$/.test(na) || /^_+$/.test(nb)) return false;
  return na === nb;
}
