/**
 * Локальный countdown «На время». Server SoT — boolean mute;
 * expiry только снимает UI until, не unmute API.
 */
import {
  CONVERSATION_MUTE_DEFAULT_DURATION_MS,
  isConversationMuteActive,
} from "@flora/client-core/messaging";
import { useSyncExternalStore } from "react";

const untilByPeer: Record<string, number> = {};
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return untilByPeer;
}

export function setTemporaryMute(peerUuid: string, durationMs = CONVERSATION_MUTE_DEFAULT_DURATION_MS) {
  const id = peerUuid.trim();
  if (!id) return;
  untilByPeer[id] = Date.now() + durationMs;
  emit();
}

export function clearTemporaryMute(peerUuid: string) {
  const id = peerUuid.trim();
  if (!id || !(id in untilByPeer)) return;
  delete untilByPeer[id];
  emit();
}

export function pruneExpiredTemporaryMutes(nowMs = Date.now()) {
  let changed = false;
  for (const [peerUuid, untilMs] of Object.entries(untilByPeer)) {
    if (!isConversationMuteActive({ kind: "until", untilMs }, nowMs)) {
      delete untilByPeer[peerUuid];
      changed = true;
    }
  }
  if (changed) emit();
}

export function useTemporaryMuteUntilByPeer(): Readonly<Record<string, number>> {
  return useSyncExternalStore(subscribe, getSnapshot, () => untilByPeer);
}

export function useIsTemporaryMuteActive(peerUuid: string | null | undefined): boolean {
  const map = useTemporaryMuteUntilByPeer();
  const id = peerUuid?.trim();
  if (!id) return false;
  const untilMs = map[id];
  if (untilMs == null) return false;
  return isConversationMuteActive({ kind: "until", untilMs });
}
