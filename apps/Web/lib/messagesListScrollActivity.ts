/** Chat-list scroll gate. Jobs must not start while this is true, and nothing here writes scroll offsets. */
const SCROLL_IDLE_MS = 120;

let scrolling = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function isMessagesListScrolling(): boolean {
  return scrolling;
}

export function noteMessagesListScroll(): void {
  scrolling = true;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    scrolling = false;
    timer = null;
  }, SCROLL_IDLE_MS);
}

export function resetMessagesListScrollForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  scrolling = false;
}
