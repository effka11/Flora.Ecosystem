function pluralRu(n: number, forms: [string, string, string]): string {
  const nAbs = Math.abs(n) % 100;
  const n1 = nAbs % 10;
  if (nAbs > 10 && nAbs < 20) return forms[2];
  if (n1 === 1) return forms[0];
  if (n1 >= 2 && n1 <= 4) return forms[1];
  return forms[2];
}

function calendarMonthDiff(from: Date, to: Date): number {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(0, months);
}

function calendarYearDiff(from: Date, to: Date): number {
  let y = to.getFullYear() - from.getFullYear();
  const mFrom = from.getMonth();
  const mTo = to.getMonth();
  const dFrom = from.getDate();
  const dTo = to.getDate();
  if (mTo < mFrom || (mTo === mFrom && dTo < dFrom)) y -= 1;
  return Math.max(0, y);
}

/** Статус последнего визита для шапки чата: только относительное время. */
export function formatWasOnlineRu(
  lastSeenIso: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const raw = lastSeenIso?.trim();
  if (!raw) return null;
  const thenMs = Date.parse(raw);
  if (!Number.isFinite(thenMs)) return null;

  let diff = now.getTime() - thenMs;
  if (diff < 0) diff = 0;

  const min = Math.floor(diff / 60000);
  const days = Math.floor(diff / 86400000);

  if (min < 1) return "Только что";
  if (min < 2) return "Минуту назад";
  if (min <= 59) return `${min} ${pluralRu(min, ["минута", "минуты", "минут"])} назад`;

  if (min < 120) return "Час назад";

  const h = Math.floor(min / 60);
  if (h <= 23) return `${h} ${pluralRu(h, ["час", "часа", "часов"])} назад`;

  if (days === 1) return "День назад";
  if (days >= 2 && days <= 6) return `${days} ${pluralRu(days, ["день", "дня", "дней"])} назад`;
  if (days >= 7 && days <= 13) return "Неделю назад";
  if (days >= 14 && days <= 20) return "2 недели назад";
  if (days >= 21 && days <= 27) return "3 недели назад";
  if (days >= 28 && days <= 34) return "4 недели назад";

  const then = new Date(thenMs);
  const md = calendarMonthDiff(then, now);
  const yd = calendarYearDiff(then, now);

  if (yd >= 2) return `${yd} ${pluralRu(yd, ["год", "года", "лет"])} назад`;
  if (yd === 1 && md >= 13) return "Год назад";
  if (md === 12) return "12 месяцев назад";
  if (md >= 2 && md <= 11) return `${md} ${pluralRu(md, ["месяц", "месяца", "месяцев"])} назад`;
  if (md === 1) return "Месяц назад";
  if (yd === 1) return "Год назад";

  if (days >= 35) return "Месяц назад";
  return `${days} ${pluralRu(days, ["день", "дня", "дней"])} назад`;
}
