"use client";

import { useEffect, useRef } from "react";
import { decryptGroupMessageWire, isFscpGroupWirePayload } from "@flora/client-core/fscp";
import { parseDemoPlaintextWire } from "@/lib/devLocalDemoData";
import { decryptFscpWireEnvelope, isFscpWirePayload, type FscpMessagePlaintext } from "@/lib/fscp";
import {
  plaintextThreadKey,
  rememberMessagePlaintext,
  type PlaintextThreadKind,
} from "@/lib/messagePlaintextSessionCache";
import {
  planThreadDecryptBatches,
  scheduleDecryptSlice,
  THREAD_DECRYPT_SLICE,
} from "@/lib/threadPlaintextWarm";
import type { MessageThreadItemDto } from "@/lib/socialApi";
import {
  markMessagesOpenPlaintextDone,
  noteMessagesOpenDecryptCall,
} from "./messagesOpenTrace";

const DECRYPT_FAIL_LABEL = "[ не удалось расшифровать ]";

type DecryptOutcome =
  | { messageUuid: string; wire: string; plain: FscpMessagePlaintext }
  | { messageUuid: string; wire: string; failed: true };

export function needsDecrypt(
  message: MessageThreadItemDto,
  decrypted: Record<string, FscpMessagePlaintext>,
  failed: Record<string, string>,
): boolean {
  if (decrypted[message.messageUuid] || failed[message.messageUuid]) return false;
  const wire = message.encryptedForMe?.trim() ?? "";
  if (!wire || parseDemoPlaintextWire(wire)) return false;
  return isFscpWirePayload(wire) || isFscpGroupWirePayload(wire);
}

async function decryptMessage(
  message: MessageThreadItemDto,
  viewerUserUuid: string,
  agreementPrivateKey: Uint8Array,
): Promise<DecryptOutcome | null> {
  const wire = message.encryptedForMe?.trim() ?? "";
  if (!wire) return null;
  const demo = parseDemoPlaintextWire(wire);
  if (demo) return { messageUuid: message.messageUuid, wire, plain: demo };
  if (!isFscpWirePayload(wire) && !isFscpGroupWirePayload(wire)) return null;
  noteMessagesOpenDecryptCall();
  try {
    if (isFscpGroupWirePayload(wire)) {
      const plain = await decryptGroupMessageWire({
        wire,
        viewerUserUuid,
        agreementPrivateKey,
      });
      return { messageUuid: message.messageUuid, wire, plain: plain.plaintext };
    }
    const plain = await decryptFscpWireEnvelope({
      wire,
      viewerUserUuid,
      agreementPrivateKey,
    });
    return { messageUuid: message.messageUuid, wire, plain };
  } catch {
    return { messageUuid: message.messageUuid, wire, failed: true };
  }
}

function applyOutcomes(
  outcomes: Array<DecryptOutcome | null>,
  threadKey: string | null,
  setDecryptedById: (update: (prev: Record<string, FscpMessagePlaintext>) => Record<string, FscpMessagePlaintext>) => void,
  setDecryptFailById: (update: (prev: Record<string, string>) => Record<string, string>) => void,
): void {
  const plains: Record<string, FscpMessagePlaintext> = {};
  const fails: Record<string, string> = {};
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if ("plain" in outcome) {
      plains[outcome.messageUuid] = outcome.plain;
      if (threadKey) {
        rememberMessagePlaintext(threadKey, outcome.messageUuid, outcome.wire, { text: outcome.plain });
      }
    } else {
      fails[outcome.messageUuid] = DECRYPT_FAIL_LABEL;
      if (threadKey) {
        rememberMessagePlaintext(threadKey, outcome.messageUuid, outcome.wire, { failed: true });
      }
    }
  }
  if (Object.keys(plains).length > 0) {
    setDecryptedById((prev) => ({ ...prev, ...plains }));
  }
  if (Object.keys(fails).length > 0) {
    setDecryptFailById((prev) => ({ ...prev, ...fails }));
  }
}

export function useThreadDecrypt(options: {
  viewerNorm: string;
  threadKind: PlaintextThreadKind | null;
  threadId: string | null;
  messages: MessageThreadItemDto[];
  decryptedById: Record<string, FscpMessagePlaintext>;
  decryptFailById: Record<string, string>;
  setDecryptedById: (
    update: (prev: Record<string, FscpMessagePlaintext>) => Record<string, FscpMessagePlaintext>,
  ) => void;
  setDecryptFailById: (update: (prev: Record<string, string>) => Record<string, string>) => void;
  viewerUserUuid: string;
  agreementPrivateKey: Uint8Array | null;
  threadFetchedForViewerNorm: string | null;
}): void {
  const decryptedRef = useRef(options.decryptedById);
  const failedRef = useRef(options.decryptFailById);
  const setDecryptedRef = useRef(options.setDecryptedById);
  const setFailedRef = useRef(options.setDecryptFailById);

  const {
    viewerNorm,
    threadKind,
    threadId,
    messages,
    decryptedById,
    decryptFailById,
    setDecryptedById,
    setDecryptFailById,
    viewerUserUuid,
    agreementPrivateKey,
    threadFetchedForViewerNorm,
  } = options;

  useEffect(() => {
    decryptedRef.current = decryptedById;
    failedRef.current = decryptFailById;
    setDecryptedRef.current = setDecryptedById;
    setFailedRef.current = setDecryptFailById;
  }, [decryptedById, decryptFailById, setDecryptedById, setDecryptFailById]);

  useEffect(() => {
    if (!viewerNorm || !threadKind || !threadId || !agreementPrivateKey || !viewerUserUuid) return;
    if (!threadFetchedForViewerNorm || threadFetchedForViewerNorm !== viewerNorm) return;
    let cancelled = false;
    const threadKey = plaintextThreadKey(viewerNorm, threadKind, threadId);
    const plan = planThreadDecryptBatches(messages, (message) =>
      needsDecrypt(message, decryptedRef.current, failedRef.current),
    );

    const resolveMany = (batch: MessageThreadItemDto[]) =>
      Promise.all(
        batch.map((message) => decryptMessage(message, viewerUserUuid, agreementPrivateKey)),
      );

    const apply = (outcomes: Array<DecryptOutcome | null>) => {
      if (cancelled) return;
      applyOutcomes(outcomes, threadKey, setDecryptedRef.current, setFailedRef.current);
    };

    const runRest = (batches: MessageThreadItemDto[][], index: number) => {
      if (cancelled || index >= batches.length) {
        if (!cancelled) markMessagesOpenPlaintextDone(threadId);
        return;
      }
      scheduleDecryptSlice(() => {
        if (cancelled) return;
        void resolveMany(batches[index] ?? []).then((outcomes) => {
          apply(outcomes);
          runRest(batches, index + 1);
        });
      });
    };

    void resolveMany(plan.flush).then((outcomes) => {
      apply(outcomes);
      if (plan.restBatches.length === 0) {
        if (!cancelled) markMessagesOpenPlaintextDone(threadId);
        return;
      }
      runRest(plan.restBatches, 0);
    });

    return () => {
      cancelled = true;
    };
  }, [
    agreementPrivateKey,
    messages,
    threadFetchedForViewerNorm,
    threadId,
    threadKind,
    viewerNorm,
    viewerUserUuid,
  ]);
}

export { THREAD_DECRYPT_SLICE };
