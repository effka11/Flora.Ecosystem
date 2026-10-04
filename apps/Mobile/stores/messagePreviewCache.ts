/** Ключ = сам шифротекст: уникален per-message и не зависит от формата даты сервера. */
export function messagePreviewKey(
  encryptedForMe: string | null | undefined,
  lastMessageAt: string,
): string {
  const enc = encryptedForMe?.trim() ?? "";
  return enc || `plain|${lastMessageAt.trim()}`;
}

const cache = new Map<string, { msgKey: string; text: string }>();

export const messagePreviewCache = {
  get(conversationUuid: string): { msgKey: string; text: string } | undefined {
    return cache.get(conversationUuid);
  },
  set(conversationUuid: string, msgKey: string, text: string): void {
    cache.set(conversationUuid, { msgKey, text });
  },
  clear(): void {
    cache.clear();
  },
};
