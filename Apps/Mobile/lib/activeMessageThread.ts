import { setSecurePushActiveConversation } from "flora-secure-push";

let activeConversationUuid: string | null = null;

type ActiveThreadListener = (conversationUuid: string | null) => void;
const listeners = new Set<ActiveThreadListener>();

export function setActiveMessageThread(conversationUuid: string | null): void {
  const norm = conversationUuid?.trim().toLowerCase() ?? "";
  const next = norm.length > 0 ? norm : null;
  if (next === activeConversationUuid) return;
  activeConversationUuid = next;
  setSecurePushActiveConversation(activeConversationUuid);
  for (const listener of Array.from(listeners)) listener(next);
}

export function getActiveMessageThread(): string | null {
  return activeConversationUuid;
}

/**
 * Смена активного треда (вход/выход из чата). Фоновый прогрев по ней
 * возобновляется сразу после выхода, а не по опросному таймеру.
 */
export function subscribeActiveMessageThread(listener: ActiveThreadListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
