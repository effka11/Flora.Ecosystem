import {
  RECOVERY_WORDLIST_EN_V1,
  RECOVERY_WORDLIST_ID,
  RECOVERY_WORDS_COUNT,
} from "./recoveryWordlistEnV1.js";

export { RECOVERY_WORDLIST_ID, RECOVERY_WORDS_COUNT };

/** Генерирует 12 случайных слов из фиксированного словаря (BIP39 English, flora-recovery-en-v1). */
export function generateRecoveryPhrase(): string {
  const words: string[] = [];
  const random = new Uint32Array(RECOVERY_WORDS_COUNT);
  globalThis.crypto.getRandomValues(random);
  for (let i = 0; i < RECOVERY_WORDS_COUNT; i++) {
    const index = random[i]! % RECOVERY_WORDLIST_EN_V1.length;
    words.push(RECOVERY_WORDLIST_EN_V1[index]!);
  }
  return words.join(" ");
}

export function normalizeRecoveryPhrase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/g, " ");
}

export function validateRecoveryPhrase(input: string): string | null {
  const normalized = normalizeRecoveryPhrase(input);
  if (!normalized) return "Введите ключ-фразу.";
  const parts = normalized.split(" ");
  if (parts.length !== RECOVERY_WORDS_COUNT)
    return `Ключ-фраза должна содержать ${RECOVERY_WORDS_COUNT} слов.`;
  for (const word of parts) {
    if (!RECOVERY_WORDLIST_EN_V1.includes(word))
      return `Слово «${word}» отсутствует в словаре восстановления.`;
  }
  return null;
}
