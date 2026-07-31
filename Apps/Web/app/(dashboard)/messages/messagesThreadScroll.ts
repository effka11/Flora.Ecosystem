/** Порог «у низа» ленты сообщений (px). */
export const MESSAGES_NEAR_BOTTOM_PX = 72;

/** Как Mobile LIST_REVEAL_DEADLINE — не ждать decrypt вечно при open. */
export const MESSAGES_OPEN_REVEAL_DEADLINE_MS = 1200;

/** Окно принудительного re-pin после open / insert (картинки, compose padding). */
export const MESSAGES_REPIN_WINDOW_MS = 600;

export function messagesScrollGapPx(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function isMessagesNearBottom(el: HTMLElement, nearBottomPx = MESSAGES_NEAR_BOTTOM_PX): boolean {
  return messagesScrollGapPx(el) < nearBottomPx;
}

export function pinMessagesScrollToBottom(el: HTMLElement, behavior: ScrollBehavior): void {
  el.scrollTo({ top: el.scrollHeight, behavior });
}

/** Optimistic uuid → real: seen без повторного insertLift. */
export function noteOptimisticUuidReplace(
  seen: Set<string>,
  optimisticMessageUuid: string,
  realMessageUuid: string,
): void {
  seen.delete(optimisticMessageUuid);
  seen.add(realMessageUuid);
}
