import type { Href } from "expo-router";

function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

export function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function usernamesEqual(a: string, b: string): boolean {
  return normalizeUsername(a).toLowerCase() === normalizeUsername(b).toLowerCase();
}

/** Профиль внутри tab navigator — tab bar виден, без root header. */
export function profileScreenHref(username: string, meUsername?: string | null): Href {
  const slug = normalizeUsername(username) || "user";
  if (meUsername && usernamesEqual(slug, meUsername)) {
    return "/(tabs)/profile";
  }
  return {
    pathname: "/(tabs)/profile/[username]",
    params: { username: slug },
  };
}

export function isOwnUsername(username: string, meUsername?: string | null): boolean {
  return !!meUsername && !!username && usernamesEqual(username, meUsername);
}

/** Страница сообщества внутри скрытого tab communities. */
export function communityScreenHref(slug: string): Href {
  return {
    pathname: "/(tabs)/communities/[slug]",
    params: { slug: slug.trim() },
  };
}
