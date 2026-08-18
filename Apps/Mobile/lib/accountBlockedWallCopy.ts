/** Copy for the blocked-account wall. `until` is `me.accountBlockedUntil` after `/me` parse. */

export function formatAccountBlockedUntil(until: string): string | null {
  const ms = Date.parse(until);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Body under the wall title. Permanence only when `until === null`.
 * A missing until (`undefined`) claims neither a date nor that the block is forever.
 */
export function accountBlockedWallBody(until: string | null | undefined): string {
  if (until === null) {
    return "Блокировка постоянная.";
  }
  if (typeof until === "string") {
    const formatted = formatAccountBlockedUntil(until);
    if (formatted) return `Блокировка действует до ${formatted}.`;
  }
  return "Вы не можете пользоваться Flora с этого аккаунта.";
}
