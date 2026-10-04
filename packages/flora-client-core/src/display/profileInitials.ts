function normalizedHandle(username: string): string {
  return username.trim().replace(/^@+/, "");
}

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
export function profileInitials(displayName: string, username: string): string {
  const d = displayName.trim();
  const u = normalizedHandle(username);
  const uOk = isRenderableUsername(username);

  if (d.length >= 2) return d.slice(0, 2).toUpperCase();
  if (d.length === 1) {
    const u0 = uOk ? u[0] : undefined;
    return (d + (u0 ?? "?")).slice(0, 2).toUpperCase();
  }
  if (!uOk) return "?";
  if (u.length >= 2) return u.slice(0, 2).toUpperCase();
  if (u.length === 1) return `${u[0]!.toUpperCase()}?`;
  return "?";
}

/** Инициалы для сообщества (без @handle). */
export function communityInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2) return trimmed.slice(0, 2).toUpperCase();
  if (trimmed.length === 1) return `${trimmed[0]!.toUpperCase()}?`;
  return "?";
}
