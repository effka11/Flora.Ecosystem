/**
 * Метка «процесс умер, пока был открыт системный пикер фото» — RN-free часть.
 *
 * Пикер запускает чужое activity, и на слабых устройствах система успевает
 * выгрузить наш процесс. JS-навигация смерть процесса не переживает: холодный
 * старт ставит приложение на список чатов, хотя пользователь никуда не уходил.
 * Метка пишется перед запуском пикера и снимается в его `finally`; уцелевшая
 * метка — единственное доказательство, что старт не добровольный, и только по
 * ней холодный старт возвращает чат. Обычный перезапуск приложения метку не
 * находит и остаётся на списке.
 */

export const CHAT_PICK_PENDING_VERSION = 1;
/**
 * Пикер — короткое действие. Более старую метку не считаем доказательством:
 * телефон мог выгрузить процесс позже и по другой причине, а пользователь уже
 * не помнит, что открывал галерею.
 */
export const CHAT_PICK_PENDING_TTL_MS = 15 * 60 * 1000;

export type ChatPickPending = {
  v: typeof CHAT_PICK_PENDING_VERSION;
  conversationUuid: string;
  at: number;
};

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildChatPickPending(
  conversationUuid: string,
  at: number = Date.now(),
): ChatPickPending | null {
  const uuid = clean(conversationUuid);
  if (!uuid || !Number.isFinite(at)) return null;
  return { v: CHAT_PICK_PENDING_VERSION, conversationUuid: uuid, at };
}

export function isChatPickPendingFresh(
  pending: ChatPickPending,
  now: number = Date.now(),
): boolean {
  const age = now - pending.at;
  return Number.isFinite(age) && age >= 0 && age <= CHAT_PICK_PENDING_TTL_MS;
}

export function parseChatPickPending(
  raw: string | null | undefined,
  now: number = Date.now(),
): ChatPickPending | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const source = parsed as Record<string, unknown>;
  if (source.v !== CHAT_PICK_PENDING_VERSION) return null;
  const conversationUuid = clean(source.conversationUuid);
  const at = typeof source.at === "number" ? source.at : NaN;
  if (!conversationUuid || !Number.isFinite(at)) return null;
  const pending: ChatPickPending = {
    v: CHAT_PICK_PENDING_VERSION,
    conversationUuid,
    at,
  };
  return isChatPickPendingFresh(pending, now) ? pending : null;
}
