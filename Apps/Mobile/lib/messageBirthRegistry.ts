/**
 * Реестр birth-анимации пузырей: играть только на delta после ready треда,
 * не на гидрации и не при recycle.
 */

const played = new Set<string>();
const pending = new Set<string>();
const clientKeyByMessageUuid = new Map<string, string>();

export function optimisticPayloadSentinel(clientMessageKey: string): string {
  return `flora-optimistic:${clientMessageKey}`;
}

export function isOptimisticPayloadSentinel(payload: string | null | undefined): boolean {
  return typeof payload === "string" && payload.startsWith("flora-optimistic:");
}

export function rememberClientMessageKey(messageUuid: string, clientMessageKey: string): void {
  clientKeyByMessageUuid.set(messageUuid.trim().toLowerCase(), clientMessageKey);
}

export function takeClientMessageKey(messageUuid: string): string | undefined {
  return clientKeyByMessageUuid.get(messageUuid.trim().toLowerCase());
}

export function rebindClientMessageKey(tempUuid: string, realUuid: string): void {
  const key = takeClientMessageKey(tempUuid) ?? tempUuid;
  clientKeyByMessageUuid.delete(tempUuid.trim().toLowerCase());
  rememberClientMessageKey(realUuid, key);
  if (played.has(tempUuid) || played.has(key)) {
    played.add(key);
    played.add(realUuid);
  }
  if (pending.has(tempUuid)) {
    pending.delete(tempUuid);
    pending.add(key);
  }
}

export function markBirthPending(clientMessageKey: string): void {
  if (played.has(clientMessageKey)) return;
  pending.add(clientMessageKey);
}

export function peekBirthPending(clientMessageKey: string): boolean {
  return pending.has(clientMessageKey) && !played.has(clientMessageKey);
}

/** Забрать право на birth; played ставится только после завершения анимации. */
export function consumeBirthPending(clientMessageKey: string): boolean {
  if (played.has(clientMessageKey)) return false;
  if (!pending.has(clientMessageKey)) return false;
  pending.delete(clientMessageKey);
  return true;
}

export function markBirthPlayed(clientMessageKey: string): void {
  pending.delete(clientMessageKey);
  played.add(clientMessageKey);
}

export function hasBirthPlayed(clientMessageKey: string): boolean {
  return played.has(clientMessageKey);
}

/** Сброс при смене треда / logout — без накопления played/clientKey. */
export function resetBirthTracking(): void {
  pending.clear();
  played.clear();
  clientKeyByMessageUuid.clear();
}

/** Гидрация: не трогать ключи, уже стоящие в pending (optimistic / live delta). */
export function seedHydratedKeys(clientMessageKeys: string[]): void {
  for (const key of clientMessageKeys) {
    if (pending.has(key)) continue;
    played.add(key);
  }
}
