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

export type ChatListInsertLiftOptions = {
  /**
   * Элементы внутри `innerEl`, которые должны остаться на месте в viewport
   * (контр-transform −H→0), пока лента едет с +H→0.
   * Для peer-аватара хвоста — только при append в уже видимую группу;
   * при появлении аватара hold не передаём (едет вместе с сообщением).
   */
  holdViewportEls?: readonly HTMLElement[];
};

function bumpGeneration(el: HTMLElement): number {
  const generation = (liftGenerationByEl.get(el) ?? 0) + 1;
  liftGenerationByEl.set(el, generation);
  return generation;
}

function clearLiftStyles(el: HTMLElement): void {
  el.style.transition = "";
  el.style.transform = "";
  el.style.willChange = "";
}

/**
 * После insert у якоря: до paint компенсируем скачок layout (+height), затем
 * анимируем в 0 — лента едет на inner; holdViewportEls остаются в кадре.
 */
export function playChatListInsertLift(
  innerEl: HTMLElement,
  heightPx: number,
  options?: ChatListInsertLiftOptions,
): void {
  const h = Math.max(0, Math.round(heightPx));
  if (h <= 0) return;

  const hold = (options?.holdViewportEls ?? []).filter((el) => innerEl.contains(el));
  const generation = bumpGeneration(innerEl);
  for (const el of hold) bumpGeneration(el);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  innerEl.style.willChange = "transform";
  innerEl.style.transition = "none";
  innerEl.style.transform = `translateY(${h}px)`;
  for (const el of hold) {
    el.style.willChange = "transform";
    el.style.transition = "none";
    el.style.transform = `translateY(${-h}px)`;
  }

  if (reduced) {
    clearLiftStyles(innerEl);
    for (const el of hold) clearLiftStyles(el);
    return;
  }

  void innerEl.offsetHeight;

  // После долгого idle браузер может парковать rAF до input-события — double-rAF
  // тогда откладывает старт transition. Параллельный setTimeout будит timeline.
  let started = false;
  const startLift = () => {
    if (started) return;
    if (liftGenerationByEl.get(innerEl) !== generation) return;
    started = true;
    const transition = `transform ${CHAT_INSERT_LIFT_MS}ms ${LIFT_EASING}`;
    innerEl.style.transition = transition;
    innerEl.style.transform = "translateY(0)";
    for (const el of hold) {
      if (liftGenerationByEl.get(el) == null) continue;
      el.style.transition = transition;
      el.style.transform = "translateY(0)";
    }
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(startLift);
  });
  window.setTimeout(startLift, 32);

  window.setTimeout(() => {
    if (liftGenerationByEl.get(innerEl) !== generation) return;
    clearLiftStyles(innerEl);
    for (const el of hold) clearLiftStyles(el);
  }, CHAT_INSERT_LIFT_MS + 48);
}

export function resetChatListInsertLift(innerEl: HTMLElement | null): void {
  if (!innerEl) return;
  bumpGeneration(innerEl);
  clearLiftStyles(innerEl);
  for (const el of innerEl.querySelectorAll<HTMLElement>("[data-messages-peer-avatar]")) {
    bumpGeneration(el);
    clearLiftStyles(el);
  }
}

/** Аватар последней peer-группы в ленте — якорь хвоста для hold при peer-insert. */
export function queryTrailingPeerAvatar(innerEl: HTMLElement): HTMLElement | null {
  const groups = innerEl.querySelectorAll<HTMLElement>("[data-messages-peer-group]");
  const last = groups[groups.length - 1];
  if (!last) return null;
  return last.querySelector<HTMLElement>("[data-messages-peer-avatar]");
}
