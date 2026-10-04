/** Бейдж в сайдбаре: скрыт при 0, «99+» при count > 99. */
export function formatNavBadge(count: number): string | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  if (count > 99) return "99+";
  return String(count);
}
