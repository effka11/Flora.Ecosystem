const dev = process.env.NODE_ENV !== "production";

let decryptCalls = 0;

export function resetMessagesOpenTrace(): void {
  decryptCalls = 0;
}

export function messagesOpenDecryptCalls(): number {
  return decryptCalls;
}

export function noteMessagesOpenDecryptCall(): void {
  decryptCalls += 1;
  mark("messages-open:decrypt");
}

export function markMessagesOpenClick(threadId: string): void {
  mark(`messages-open:click:${threadId}`);
}

export function markMessagesOpenFirstRows(threadId: string): void {
  mark(`messages-open:first-rows:${threadId}`);
}

export function markMessagesOpenPin(threadId: string): void {
  mark(`messages-open:pin:${threadId}`);
}

export function markMessagesOpenPlaintextDone(threadId: string): void {
  mark(`messages-open:plaintext-done:${threadId}`);
}

function mark(name: string): void {
  if (!dev || typeof performance === "undefined" || typeof performance.mark !== "function") return;
  performance.mark(name);
}
