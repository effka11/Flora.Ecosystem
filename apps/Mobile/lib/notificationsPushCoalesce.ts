import type { QueryClient } from "@tanstack/react-query";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";

export const NOTIFICATIONS_PUSH_COALESCE_MS = 400;
export const NOTIFICATIONS_PUSH_COALESCE_FOCUSED_MS = 100;

let listFocused = false;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let unsubIdle: (() => void) | null = null;
let queuedClient: QueryClient | null = null;

export function setNotificationsListFocused(focused: boolean): void {
  listFocused = focused;
}

function clearIdleWait(): void {
  unsubIdle?.();
  unsubIdle = null;
  queuedClient = null;
}

function runRefetch(queryClient: QueryClient): void {
  void queryClient.refetchQueries({ queryKey: ["notifications"] });
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

export function scheduleNotificationsPushRefresh(queryClient: QueryClient): void {
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  clearIdleWait();
  const delay = listFocused
    ? NOTIFICATIONS_PUSH_COALESCE_FOCUSED_MS
    : NOTIFICATIONS_PUSH_COALESCE_MS;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    fireRefresh(queryClient);
  }, delay);
}

/** test-only */
export function __resetNotificationsPushCoalesce(): void {
  if (pendingTimer != null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  clearIdleWait();
  listFocused = false;
}
