/** Склонение числа n для форм [один, два-четыре, пять+]. */
function pluralRu(n: number, forms: [string, string, string]): string {
  const nAbs = Math.abs(n) % 100;
  const n1 = nAbs % 10;
  if (nAbs > 10 && nAbs < 20) return forms[2];
  if (n1 === 1) return forms[0];
  if (n1 >= 2 && n1 <= 4) return forms[1];
  return forms[2];
}

export type ConversationMuteEntry =
  | { kind: "forever" }
  | { kind: "until"; untilMs: number };

/** Длительность «На время», пока нет экрана «Параметры». */
export const CONVERSATION_MUTE_DEFAULT_DURATION_MS = 8 * 60 * 60 * 1000;

export function isConversationMuteActive(entry: ConversationMuteEntry, nowMs = Date.now()): boolean {
  if (entry.kind === "forever") return true;
  return entry.untilMs > nowMs;
}

export function formatConversationMuteTooltip(entry: ConversationMuteEntry, nowMs = Date.now()): string {
  if (entry.kind === "forever") return "бессрочно";
  const remainingMs = entry.untilMs - nowMs;
  if (remainingMs <= 0) return "Заглушение истекает";

  const totalSec = Math.ceil(remainingMs / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);

  if (days > 0) {
    return `Осталось ${days} ${pluralRu(days, ["день", "дня", "дней"])}`;
  }
  if (hours > 0 && mins > 0) {
    return `Осталось ${hours} ${pluralRu(hours, ["час", "часа", "часов"])} ${mins} ${pluralRu(mins, ["минута", "минуты", "минут"])}`;
  }
  if (hours > 0) {
    return `Осталось ${hours} ${pluralRu(hours, ["час", "часа", "часов"])}`;
  }
  if (mins > 0) {
    return `Осталось ${mins} ${pluralRu(mins, ["минута", "минуты", "минут"])}`;
  }
  return "Осталось меньше минуты";
}
