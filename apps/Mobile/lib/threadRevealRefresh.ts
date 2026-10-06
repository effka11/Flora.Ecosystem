/**
 * После показа ленты сеть нужна только если закрытый тред успели пометить
 * устаревшим или список знает более новое сообщение, чем страница в кэше.
 */
export function shouldRefetchThreadAfterReveal(input: {
  isInvalidated: boolean;
  lastMessageAt: string | null | undefined;
  newestCreatedAt: string | null | undefined;
}): boolean {
  if (input.isInvalidated) return true;
  const lastMessageAt = input.lastMessageAt?.trim() ?? "";
  if (!lastMessageAt) return false;
  const newestCreatedAt = input.newestCreatedAt?.trim() ?? "";
  return !newestCreatedAt || newestCreatedAt < lastMessageAt;
}
