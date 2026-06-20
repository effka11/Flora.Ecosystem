/** Отметка времени для списка уведомлений (ru). */
export function formatNotificationTimeAgoRu(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "сейчас";
  if (mins < 60) return `${mins} мин назад`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч назад`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} д назад`;
  return new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
