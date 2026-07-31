import type { FscpMessageBlock, FscpMessagePlaintext } from "@/lib/fscp";

/** Общий тайминг подъёма ленты при появлении сообщения у якоря (паритет Mobile). */
export const CHAT_INSERT_LIFT_MS = 220;

const LIFT_EASING = "var(--flora-ease-out)";

const liftGenerationByEl = new WeakMap<HTMLElement, number>();

/** Оценка высоты новой строки — fallback, если DOM ещё не измерить. */
export function estimateBlocksInsertLiftPx(blocks: FscpMessageBlock[]): number {
  if (blocks.some((b) => b.kind === "voice")) return 72;
  const images = blocks.filter((b) => b.kind === "image").length;
  if (images === 1) return 220;
  if (images > 1) return 280;
  return 52;
}

export function estimateMessageInsertLiftPx(
  content: FscpMessagePlaintext | "decrypting" | "failed",
): number {
  if (content === "decrypting" || content === "failed") return 52;
  return estimateBlocksInsertLiftPx(content.blocks);
}

/**
 * Реальная высота последних N пузырей + gap — точнее estimate, меньше щелчка в конце lift.
 */
export function measureTrailingBubblesInsertLiftPx(
  innerEl: HTMLElement,
  bubbleCount: number,
): number {
  if (bubbleCount <= 0) return 0;
  const wraps = innerEl.querySelectorAll<HTMLElement>("[data-messages-bubble-wrap]");
  const n = wraps.length;
  if (n === 0) return 0;
  const start = Math.max(0, n - bubbleCount);
  const gap = parseFloat(getComputedStyle(innerEl).rowGap || getComputedStyle(innerEl).gap || "0") || 0;
  let h = 0;
  for (let i = start; i < n; i++) {
    h += wraps[i]!.offsetHeight;
    if (i > start) h += gap;
  }
  if (start > 0) h += gap;
  return Math.max(0, Math.round(h));
}

/**
 * После insert у якоря: до paint компенсируем скачок layout (+height), затем
 * анимируем в 0 — лента и новый пузырь едут одним transform-ом на inner (не scrollport).
 *
 * Вызывать из useLayoutEffect / синхронно после pin — иначе кадр с «прыжком» до translateY.
 */
export function playChatListInsertLift(innerEl: HTMLElement, heightPx: number): void {
  const h = Math.max(0, Math.round(heightPx));
  if (h <= 0) return;

  const generation = (liftGenerationByEl.get(innerEl) ?? 0) + 1;
  liftGenerationByEl.set(innerEl, generation);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  innerEl.style.willChange = "transform";
  innerEl.style.transition = "none";
  innerEl.style.transform = `translateY(${h}px)`;

  if (reduced) {
    innerEl.style.willChange = "";
    innerEl.style.transform = "";
    return;
  }

  // Force style flush so the browser commits translateY(h) before transition to 0.
  void innerEl.offsetHeight;

  // Double rAF: гарантирует, что кадр с counter-lift уже закоммичен до включения transition.
  requestAnimationFrame(() => {
    if (liftGenerationByEl.get(innerEl) !== generation) return;
    requestAnimationFrame(() => {
      if (liftGenerationByEl.get(innerEl) !== generation) return;
      innerEl.style.transition = `transform ${CHAT_INSERT_LIFT_MS}ms ${LIFT_EASING}`;
      innerEl.style.transform = "translateY(0)";
    });
  });

  window.setTimeout(() => {
    if (liftGenerationByEl.get(innerEl) !== generation) return;
    innerEl.style.transition = "";
    innerEl.style.transform = "";
    innerEl.style.willChange = "";
  }, CHAT_INSERT_LIFT_MS + 48);
}

export function resetChatListInsertLift(innerEl: HTMLElement | null): void {
  if (!innerEl) return;
  liftGenerationByEl.set(innerEl, (liftGenerationByEl.get(innerEl) ?? 0) + 1);
  innerEl.style.transition = "";
  innerEl.style.transform = "";
  innerEl.style.willChange = "";
}
