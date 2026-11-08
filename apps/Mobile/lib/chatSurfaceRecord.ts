/**
 * MMKV-биндинг записи последнего открытого чата (см. `chatSurfaceRecordCore`).
 * Ключ лежит в основном инстансе настроек: это не секрет и не требует
 * отдельного wipe-контейнера, но очищается на logout вместе с сессией.
 */
import { mmkv } from "@/lib/mmkv";
import {
  chatSurfaceRecordKey,
  parseChatSurfaceRecord,
  type ChatSurfaceRecord,
} from "@/lib/chatSurfaceRecordCore";

const CHAT_SURFACE_KEY = "chat.surface.v1";

export function readChatSurface(now: number = Date.now()): ChatSurfaceRecord | null {
  const raw = mmkv.getString(CHAT_SURFACE_KEY) ?? null;
  const record = parseChatSurfaceRecord(raw, now);
  if (raw != null && record == null) {
    // Повреждённая/устаревшая запись не должна пытаться восстанавливаться
    // на каждом старте.
    mmkv.delete(CHAT_SURFACE_KEY);
  }
  return record;
}

export function writeChatSurface(record: ChatSurfaceRecord): void {
  mmkv.set(CHAT_SURFACE_KEY, JSON.stringify(record));
}

/**
 * Запись при каждом коммите треда: сравнение по ключу маршрута, чтобы
 * presence/онлайн-поля не превращали каждое обновление в синхронную запись
 * MMKV.
 */
export function syncChatSurface(record: ChatSurfaceRecord): void {
  const current = readChatSurface(record.savedAt);
  if (current != null && chatSurfaceRecordKey(current) === chatSurfaceRecordKey(record)) {
    return;
  }
  writeChatSurface(record);
}

/**
 * Забыть поверхность. Без uuid — безусловно (logout); с uuid — только если
 * запись про этот чат (поздний cleanup старого экрана не стирает новый).
 */
export function forgetChatSurface(conversationUuid?: string): void {
  if (conversationUuid == null) {
    mmkv.delete(CHAT_SURFACE_KEY);
    return;
  }
  const current = readChatSurface();
  if (current == null) return;
  if (current.conversationUuid.trim().toLowerCase() !== conversationUuid.trim().toLowerCase()) {
    return;
  }
  mmkv.delete(CHAT_SURFACE_KEY);
}
