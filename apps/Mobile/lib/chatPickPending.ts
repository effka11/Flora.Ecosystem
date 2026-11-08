/**
 * MMKV-биндинг метки «пикер фото был открыт, когда процесс умер»
 * (см. `chatPickPendingCore`). Живёт в основном инстансе настроек рядом с
 * записью поверхности чата: это не секрет, но очищается на logout.
 */
import { mmkv } from "@/lib/mmkv";
import {
  buildChatPickPending,
  parseChatPickPending,
  type ChatPickPending,
} from "@/lib/chatPickPendingCore";

const CHAT_PICK_PENDING_KEY = "chat.pick.pending.v1";

/** Синхронно перед запуском пикера: метка обязана успеть на диск. */
export function markChatPickPending(conversationUuid: string): void {
  const pending = buildChatPickPending(conversationUuid);
  if (pending == null) return;
  mmkv.set(CHAT_PICK_PENDING_KEY, JSON.stringify(pending));
}

export function clearChatPickPending(): void {
  mmkv.delete(CHAT_PICK_PENDING_KEY);
}

/** Свежая метка без удаления: нужна повторно в пределах одного возврата. */
export function readChatPickPending(now: number = Date.now()): ChatPickPending | null {
  const raw = mmkv.getString(CHAT_PICK_PENDING_KEY) ?? null;
  const pending = parseChatPickPending(raw, now);
  if (raw != null && pending == null) {
    // Устаревшая/повреждённая метка не должна всплывать на каждом старте.
    mmkv.delete(CHAT_PICK_PENDING_KEY);
  }
  return pending;
}

/** Прочитать и снять: холодное восстановление срабатывает один раз. */
export function takeChatPickPending(now: number = Date.now()): ChatPickPending | null {
  const pending = readChatPickPending(now);
  mmkv.delete(CHAT_PICK_PENDING_KEY);
  return pending;
}
