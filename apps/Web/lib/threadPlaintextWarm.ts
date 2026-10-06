import type { FscpMessagePlaintext } from "@/lib/fscp";
import { decryptFscpWireEnvelope, isFscpWirePayload } from "@/lib/fscp";
import { decryptGroupMessageWire, isFscpGroupWirePayload } from "@flora/client-core/fscp";
import { parseDemoPlaintextWire } from "@/lib/devLocalDemoData";
import { getConversationThread } from "@/lib/conversationThreadsCache";
import { getGroupConversationThread } from "@/lib/groupThreadsCache";
import { preloadMessageMediaFromPlaintexts } from "@/lib/messageMediaCache";
import {
  peekMessagePlaintext,
  plaintextThreadKey,
  rememberMessagePlaintext,
  type PlaintextThreadKind,
} from "@/lib/messagePlaintextSessionCache";

/** Newest messages decrypted before pin. */
export const THREAD_OPEN_PLAINTEXT_TAIL = 24;
/** Idle slices stay at this size. Hover may resolve the whole tail after intent. */
export const THREAD_DECRYPT_SLICE = 8;
export const THREAD_DECRYPT_MAX_BATCHES = 4;

export type DecryptBatchMessage = {
  messageUuid: string;
  encryptedForMe: string | null;
  content?: string | null;
};

export function planThreadDecryptBatches<T>(
  messages: readonly T[],
  needsDecrypt: (message: T) => boolean,
  tail = THREAD_OPEN_PLAINTEXT_TAIL,
  sliceSize = THREAD_DECRYPT_SLICE,
  maxBatches = THREAD_DECRYPT_MAX_BATCHES,
): { flush: T[]; restBatches: T[][] } {
  const split = Math.max(0, messages.length - tail);
  const flush = messages.slice(split).filter(needsDecrypt);
  const above = messages.slice(0, split).filter(needsDecrypt);
  const restBatches: T[][] = [];
  for (let index = 0; index < above.length && restBatches.length < maxBatches; index += sliceSize) {
    restBatches.push(above.slice(index, index + sliceSize));
  }
  return { flush, restBatches };
}

export function tailMessages<T>(messages: readonly T[], tail = THREAD_OPEN_PLAINTEXT_TAIL): T[] {
  return messages.slice(-tail);
}

type WarmMessage = {
  messageUuid: string;
  encryptedForMe?: string | null;
  encryptedWire?: string | null;
};

export type WarmDecryptResult = { text: FscpMessagePlaintext } | { failed: true };

async function decryptWire(
  kind: PlaintextThreadKind,
  wire: string,
  viewerUserUuid: string,
  agreementPrivateKey: Uint8Array,
): Promise<WarmDecryptResult> {
  const demo = parseDemoPlaintextWire(wire);
  if (demo) return { text: demo };
  try {
    if (kind === "group" || isFscpGroupWirePayload(wire)) {
      const plain = await decryptGroupMessageWire({
        wire,
        viewerUserUuid,
        agreementPrivateKey,
      });
      return { text: plain.plaintext };
    }
    if (!isFscpWirePayload(wire)) return { failed: true };
    const text = await decryptFscpWireEnvelope({
      wire,
      viewerUserUuid,
      agreementPrivateKey,
    });
    return { text };
  } catch {
    return { failed: true };
  }
}

function wireOf(message: WarmMessage): string {
  return (message.encryptedForMe ?? message.encryptedWire ?? "").trim();
}

export function scheduleDecryptSlice(run: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => run());
    return;
  }
  setTimeout(run, 0);
}

export function waitForDecryptSlice(): Promise<void> {
  return new Promise((resolve) => scheduleDecryptSlice(() => resolve()));
}

export async function warmThreadPlaintextTail(options: {
  kind: PlaintextThreadKind;
  viewerNorm: string;
  threadId: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
  messages: readonly WarmMessage[];
  shouldContinue?: () => boolean;
  sliceSize?: number;
  /** Idle path waits for an idle slice between groups of `sliceSize`. */
  idleSlices?: boolean;
  onDecryptCall?: () => void;
}): Promise<FscpMessagePlaintext[]> {
  const shouldContinue = options.shouldContinue ?? (() => true);
  if (!shouldContinue()) return [];
  const sliceSize = options.sliceSize ?? (options.idleSlices ? THREAD_DECRYPT_SLICE : THREAD_OPEN_PLAINTEXT_TAIL);
  const tail = tailMessages(options.messages);
  const threadKey = plaintextThreadKey(options.viewerNorm, options.kind, options.threadId);
  const plaintexts: FscpMessagePlaintext[] = [];

  for (let index = 0; index < tail.length; index += sliceSize) {
    if (options.idleSlices && index > 0) await waitForDecryptSlice();
    if (!shouldContinue()) return plaintexts;
    const slice = tail.slice(index, index + sliceSize);
    const resolved = await Promise.all(
      slice.map(async (message) => {
        const wire = wireOf(message);
        if (!wire) return null;
        const cached = peekMessagePlaintext(threadKey, message.messageUuid, wire);
        if (cached === "failed") return null;
        if (cached) return cached;
        const demo = parseDemoPlaintextWire(wire);
        if (!demo && (isFscpGroupWirePayload(wire) || isFscpWirePayload(wire))) {
          options.onDecryptCall?.();
        }
        const result = await decryptWire(
          options.kind,
          wire,
          options.viewerUserUuid,
          options.agreementPrivateKey,
        );
        rememberMessagePlaintext(
          threadKey,
          message.messageUuid,
          wire,
          "text" in result ? { text: result.text } : { failed: true },
        );
        return "text" in result ? result.text : null;
      }),
    );
    for (let slot = resolved.length - 1; slot >= 0; slot -= 1) {
      const plain = resolved[slot];
      if (plain) plaintexts.push(plain);
    }
  }

  if (shouldContinue() && plaintexts.length > 0) {
    preloadMessageMediaFromPlaintexts(plaintexts);
  }
  return plaintexts;
}

export function warmCachedDmPlaintextTail(options: {
  viewerNorm: string;
  peerUuid: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
  shouldContinue?: () => boolean;
  sliceSize?: number;
  idleSlices?: boolean;
}): Promise<void> {
  return getConversationThread(options.viewerNorm, options.peerUuid)
    .then((page) =>
      warmThreadPlaintextTail({
        kind: "dm",
        viewerNorm: options.viewerNorm,
        threadId: options.peerUuid,
        viewerUserUuid: options.viewerUserUuid,
        agreementPrivateKey: options.agreementPrivateKey,
        messages: page.items,
        shouldContinue: options.shouldContinue,
        sliceSize: options.sliceSize,
        idleSlices: options.idleSlices,
      }),
    )
    .then(() => undefined)
    .catch(() => undefined);
}

export function warmCachedGroupPlaintextTail(options: {
  viewerNorm: string;
  conversationUuid: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
  shouldContinue?: () => boolean;
  sliceSize?: number;
  idleSlices?: boolean;
}): Promise<void> {
  return getGroupConversationThread(options.viewerNorm, options.conversationUuid)
    .then((page) =>
      warmThreadPlaintextTail({
        kind: "group",
        viewerNorm: options.viewerNorm,
        threadId: options.conversationUuid,
        viewerUserUuid: options.viewerUserUuid,
        agreementPrivateKey: options.agreementPrivateKey,
        messages: page.items.map((item) => ({
          messageUuid: item.messageUuid,
          encryptedWire: item.encryptedWire,
        })),
        shouldContinue: options.shouldContinue,
        sliceSize: options.sliceSize,
        idleSlices: options.idleSlices,
      }),
    )
    .then(() => undefined)
    .catch(() => undefined);
}

export async function warmIdlePlaintextThreads(options: {
  viewerNorm: string;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array;
  dmPeerUuids: readonly string[];
  groupUuids: readonly string[];
  shouldContinue?: () => boolean;
}): Promise<void> {
  const shouldContinue = options.shouldContinue ?? (() => true);
  for (const peerUuid of options.dmPeerUuids) {
    if (!shouldContinue()) return;
    await warmCachedDmPlaintextTail({
      viewerNorm: options.viewerNorm,
      peerUuid,
      viewerUserUuid: options.viewerUserUuid,
      agreementPrivateKey: options.agreementPrivateKey,
      shouldContinue,
      idleSlices: true,
      sliceSize: THREAD_DECRYPT_SLICE,
    });
  }
  for (const conversationUuid of options.groupUuids) {
    if (!shouldContinue()) return;
    await warmCachedGroupPlaintextTail({
      viewerNorm: options.viewerNorm,
      conversationUuid,
      viewerUserUuid: options.viewerUserUuid,
      agreementPrivateKey: options.agreementPrivateKey,
      shouldContinue,
      idleSlices: true,
      sliceSize: THREAD_DECRYPT_SLICE,
    });
  }
}
