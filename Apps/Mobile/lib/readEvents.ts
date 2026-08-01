type ReadListener = (detail: {
  conversationUuid: string;
  readerUserUuid: string;
}) => void;

const listeners = new Set<ReadListener>();

export function notifyReadChanged(detail: {
  conversationUuid: string;
  readerUserUuid: string;
}): void {
  for (const l of listeners) l(detail);
}

export function subscribeRead(listener: ReadListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
