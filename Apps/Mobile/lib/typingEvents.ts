type TypingListener = (detail: {
  conversationUuid: string;
  userUuid: string;
  isTyping: boolean;
}) => void;

const listeners = new Set<TypingListener>();

export function notifyTypingChanged(detail: {
  conversationUuid: string;
  userUuid: string;
  isTyping: boolean;
}): void {
  for (const l of listeners) l(detail);
}

export function subscribeTyping(listener: TypingListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
