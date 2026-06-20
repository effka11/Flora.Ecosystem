/** Короткая отметка времени для ленты (ru). */
export function formatRelativeTimeRu(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "сейчас";
  if (mins < 60) return `${mins} м`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} д`;
  return new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
