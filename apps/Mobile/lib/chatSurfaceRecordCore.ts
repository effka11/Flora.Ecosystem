/**
 * Последний открытый чат — RN-free часть записи для восстановления поверхности.
 *
 * Система может убить процесс, пока открыт пикер фото (камера/галерея —
 * тяжёлые activity). JS-навигация не переживает смерть процесса, и после
 * холодного старта пользователь оказывается на списке чатов. Запись хранит
 * только параметры маршрута треда (без текстов и ключей), чтобы приложение
 * могло вернуть тот же чат.
 *
 * Запись снимается намеренным закрытием (back/pop) и logout; фон и смерть
 * процесса её не трогают.
 */

export const CHAT_SURFACE_RECORD_VERSION = 1;
/** Старше суток — не восстанавливаем: слишком далеко от текущего контекста. */
export const CHAT_SURFACE_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

export type ChatSurfaceRecord = {
  v: typeof CHAT_SURFACE_RECORD_VERSION;
  savedAt: number;
  conversationUuid: string;
  kind?: string;
  title?: string;
  otherUserUuid?: string;
  otherDisplayName?: string;
  otherUsername?: string;
  otherAvatarUuid?: string;
  otherAccountBlocked?: string;
  otherUserIsOnline?: string;
  otherUserLastSeenAt?: string;
};

/** Поля маршрута треда, которые переживают восстановление. */
const ROUTE_PARAM_KEYS = [
  "kind",
  "title",
  "otherUserUuid",
  "otherDisplayName",
  "otherUsername",
  "otherAvatarUuid",
  "otherAccountBlocked",
  "otherUserIsOnline",
  "otherUserLastSeenAt",
] as const;

export type ChatSurfaceRouteParams = {
  conversationUuid: string;
} & Partial<Record<(typeof ROUTE_PARAM_KEYS)[number], string>>;

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildChatSurfaceRecord(
  params: ChatSurfaceRouteParams,
  savedAt: number = Date.now(),
): ChatSurfaceRecord | null {
  const conversationUuid = clean(params.conversationUuid);
  if (!conversationUuid) return null;
  const record: ChatSurfaceRecord = {
    v: CHAT_SURFACE_RECORD_VERSION,
    savedAt,
    conversationUuid,
  };
  for (const key of ROUTE_PARAM_KEYS) {
    const value = clean(params[key]);
    if (value != null) record[key] = value;
  }
  return record;
}

export function chatSurfaceRecordKey(record: ChatSurfaceRecord): string {
  return [record.conversationUuid, ...ROUTE_PARAM_KEYS.map((key) => record[key] ?? "")].join(
    "\u0001",
  );
}

/** Восстановленный маршрут: только непустые строковые параметры. */
export function chatSurfaceRouteParams(record: ChatSurfaceRecord): ChatSurfaceRouteParams {
  const params: ChatSurfaceRouteParams = { conversationUuid: record.conversationUuid };
  for (const key of ROUTE_PARAM_KEYS) {
    const value = record[key];
    if (value != null) params[key] = value;
  }
  return params;
}

export function isChatSurfaceRecordFresh(
  record: ChatSurfaceRecord,
  now: number = Date.now(),
): boolean {
  const age = now - record.savedAt;
  return Number.isFinite(age) && age >= 0 && age <= CHAT_SURFACE_RECORD_TTL_MS;
}

export function parseChatSurfaceRecord(
  raw: string | null | undefined,
  now: number = Date.now(),
): ChatSurfaceRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const source = parsed as Record<string, unknown>;
  if (source.v !== CHAT_SURFACE_RECORD_VERSION) return null;
  const savedAt = typeof source.savedAt === "number" ? source.savedAt : NaN;
  const conversationUuid = clean(source.conversationUuid);
  if (!Number.isFinite(savedAt) || !conversationUuid) return null;
  const record: ChatSurfaceRecord = {
    v: CHAT_SURFACE_RECORD_VERSION,
    savedAt,
    conversationUuid,
  };
  for (const key of ROUTE_PARAM_KEYS) {
    const value = clean(source[key]);
    if (value != null) record[key] = value;
  }
  return isChatSurfaceRecordFresh(record, now) ? record : null;
}
