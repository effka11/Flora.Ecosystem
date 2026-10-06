import type { FscpMessagePlaintext } from "@/lib/fscp";

/**
 * Session plaintext for open-chat seeding.
 * `MESSAGES_PLAINTEXT_SESSION_CACHE` turns the whole store off.
 * At most `PLAINTEXT_THREAD_LIMIT` threads; the idle warm set is never evicted to make room.
 */
export const MESSAGES_PLAINTEXT_SESSION_CACHE = true;
export const PLAINTEXT_THREAD_LIMIT = 12;
export const PLAINTEXT_WIRE_PREFIX_LEN = 96;

export type PlaintextThreadKind = "dm" | "group";

type Slot = { kind: "text"; text: FscpMessagePlaintext } | { kind: "failed" };

type ThreadBucket = {
  slots: Map<string, Slot>;
};

const threads = new Map<string, ThreadBucket>();
const idlePinned = new Set<string>();
let enabled = MESSAGES_PLAINTEXT_SESSION_CACHE;

export function isPlaintextSessionCacheEnabled(): boolean {
  return enabled;
}

export function setPlaintextSessionCacheEnabledForTests(next: boolean): void {
  enabled = next;
}

export function resetPlaintextSessionCacheEnabledForTests(): void {
  enabled = MESSAGES_PLAINTEXT_SESSION_CACHE;
}

export function plaintextThreadKey(
  viewerNorm: string,
  kind: PlaintextThreadKind,
  threadId: string,
): string {
  return `${viewerNorm.trim().toLowerCase()}:${kind}:${threadId.trim().toLowerCase()}`;
}

export function plaintextSlotKey(messageUuid: string, wire: string): string {
  return `${messageUuid}|${wire.slice(0, PLAINTEXT_WIRE_PREFIX_LEN)}`;
}

export function pinIdlePlaintextThreads(threadKeys: readonly string[]): void {
  idlePinned.clear();
  if (!enabled) return;
  for (const key of threadKeys) {
    if (key) idlePinned.add(key);
  }
}

function oldestUnpinned(except?: string): string | undefined {
  for (const key of threads.keys()) {
    if (key === except) continue;
    if (idlePinned.has(key)) continue;
    return key;
  }
  return undefined;
}

function evictOverflow(except?: string): void {
  while (threads.size > PLAINTEXT_THREAD_LIMIT) {
    const victim = oldestUnpinned(except);
    if (!victim) break;
    threads.delete(victim);
  }
}

export function rememberMessagePlaintext(
  threadKey: string,
  messageUuid: string,
  wire: string,
  value: { text: FscpMessagePlaintext } | { failed: true },
): void {
  if (!enabled || !threadKey || !messageUuid) return;
  const existing = threads.get(threadKey);
  if (!existing && threads.size >= PLAINTEXT_THREAD_LIMIT && oldestUnpinned() === undefined) {
    return;
  }
  const bucket = existing ?? { slots: new Map<string, Slot>() };
  threads.delete(threadKey);
  bucket.slots.set(
    plaintextSlotKey(messageUuid, wire),
    "text" in value ? { kind: "text", text: value.text } : { kind: "failed" },
  );
  threads.set(threadKey, bucket);
  evictOverflow(threadKey);
}

export function peekMessagePlaintext(
  threadKey: string,
  messageUuid: string,
  wire: string,
): FscpMessagePlaintext | "failed" | null {
  if (!enabled || !threadKey) return null;
  const bucket = threads.get(threadKey);
  if (!bucket) return null;
  const slot = bucket.slots.get(plaintextSlotKey(messageUuid, wire));
  if (!slot) return null;
  return slot.kind === "text" ? slot.text : "failed";
}

export function readMessagePlaintextSeed(
  threadKey: string,
  messages: readonly { messageUuid: string; encryptedForMe: string | null }[],
): { decryptedById: Record<string, FscpMessagePlaintext>; failedIds: string[] } {
  const decryptedById: Record<string, FscpMessagePlaintext> = {};
  const failedIds: string[] = [];
  if (!enabled || !threadKey) return { decryptedById, failedIds };
  const bucket = threads.get(threadKey);
  if (!bucket) return { decryptedById, failedIds };
  for (const message of messages) {
    const wire = message.encryptedForMe?.trim() ?? "";
    if (!wire) continue;
    const slot = bucket.slots.get(plaintextSlotKey(message.messageUuid, wire));
    if (!slot) continue;
    if (slot.kind === "text") decryptedById[message.messageUuid] = slot.text;
    else failedIds.push(message.messageUuid);
  }
  return { decryptedById, failedIds };
}

export function messagePlaintextThreadCount(): number {
  return threads.size;
}

export function messagePlaintextThreadKeys(): string[] {
  return [...threads.keys()];
}

export function clearMessagePlaintextSessionCache(): void {
  threads.clear();
  idlePinned.clear();
}
