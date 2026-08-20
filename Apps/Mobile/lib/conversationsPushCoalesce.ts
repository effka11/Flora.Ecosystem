import type { QueryClient } from "@tanstack/react-query";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

export const CONVERSATIONS_PUSH_COALESCE_MS = 400;
export const CONVERSATIONS_PUSH_COALESCE_FOCUSED_MS = 100;

let listFocused = false;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let unsubIdle: (() => void) | null = null;
let queuedClient: QueryClient | null = null;

export function setConversationsListFocused(focused: boolean): void {
  listFocused = focused;
}

function clearIdleWait(): void {
  unsubIdle?.();
  unsubIdle = null;
  queuedClient = null;
}

function runRefetch(queryClient: QueryClient): void {
  void queryClient.refetchQueries({ queryKey: ["conversations"] });
  void queryClient.refetchQueries({ queryKey: ["groups"] });
}

function fireRefresh(queryClient: QueryClient): void {
  if (isScrollSettled()) {
    runRefetch(queryClient);
    return;
  }
  queuedClient = queryClient;
  if (unsubIdle) return;
  unsubIdle = subscribeScrollSettled((settled) => {
    if (!settled) return;
    const client = queuedClient;
    clearIdleWait();
    if (client) runRefetch(client);
  });
}

export function scheduleConversationsPushRefresh(queryClient: QueryClient): void {
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  clearIdleWait();
  const delay = listFocused
    ? CONVERSATIONS_PUSH_COALESCE_FOCUSED_MS
    : CONVERSATIONS_PUSH_COALESCE_MS;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    fireRefresh(queryClient);
  }, delay);
}

/** test-only */
export function __resetConversationsPushCoalesce(): void {
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  clearIdleWait();
  listFocused = false;
}
