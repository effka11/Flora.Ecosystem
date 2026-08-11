import type { FscpMessagePlaintext } from "@/lib/fscp";

/**
 * Удаляет plaintext для optimistic UUID после swap ленты на server UUID.
 * Не вызывать до замены строки в threadMessages — иначе кадр decrypting/пустой пузырь.
 */
export function dropDecryptedIds(
  prev: Record<string, FscpMessagePlaintext>,
  ids: readonly (string | null | undefined)[],
): Record<string, FscpMessagePlaintext> {
  const next = { ...prev };
  for (const id of ids) {
    if (id) delete next[id];
  }
  return next;
}
