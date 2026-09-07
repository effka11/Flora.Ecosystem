import type { FscpMessageBlock, FscpMessagePlaintext } from "@/lib/fscp";
import { sPx } from "@flora/design";
import { getViewportFrame } from "@/app/_shared/viewportFrame";

/** Общий тайминг подъёма ленты при появлении сообщения у якоря (паритет Mobile). */
export const CHAT_INSERT_LIFT_MS = 220;

/**
 * Схлопывание compose-extra на ленте (паритет Mobile `composeGrowDurationMs` /
 * CSS `transition: … 0.18s var(--flora-ease-out)`).
 */
export const COMPOSE_LIST_GROWTH_MS = 180;

/** SoT: `--flora-ease-out` в `Apps/Web/app/flora-motion.css` (WAAPI не резолвит CSS vars). */
export const CHAT_INSERT_LIFT_EASING = "cubic-bezier(0.33, 1, 0.2, 1)";

function bubbleMetrics() {
  const frame = getViewportFrame();
  return {
    lineHeight: 5 * frame.stepFine,
    fontSize: sPx(15, frame.s),
    paddingX: frame.step,
    baseLift: sPx(52, frame.s),
    belowTime: sPx(16, frame.s),
    voiceLift: sPx(72, frame.s),
    imageLift: sPx(220, frame.s),
    collageLift: sPx(280, frame.s),
  };
}

/** Базовый lift однострочного текста (паритет Mobile); эталон s=1. */
export const TEXT_BASE_INSERT_LIFT_PX = 52;

/** Запас на meta-ряд below (время + gap), когда lines ≥ 2; эталон s=1. */
export const BELOW_TIME_RESERVE_PX = 16;

const AVG_CHAR_WIDTH_FACTOR = 0.55;
const BUBBLE_MAX_WIDTH_RATIO = 0.78;

const liftGenerationByEl = new WeakMap<HTMLElement, number>();
const liftAnimationsByEl = new WeakMap<HTMLElement, Animation[]>();

export type InsertLiftEstimateCtx = {
  maxInnerWidthPx?: number;
};

/** Число визуальных строк: hard-breaks + soft-wrap; floor = split("\\n").length. */
export function estimateTextVisualLineCount(
  body: string,
  maxInnerWidthPx?: number,
): number {
  const paragraphs = body.split("\n");
  const hardFloor = Math.max(1, paragraphs.length);

  if (maxInnerWidthPx == null || maxInnerWidthPx <= 0) {
    return hardFloor;
  }

  const avgCharWidth = bubbleMetrics().fontSize * AVG_CHAR_WIDTH_FACTOR;
  const maxChars = Math.max(1, Math.floor(maxInnerWidthPx / avgCharWidth));

  let lines = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines += 1;
    } else {
      lines += Math.max(1, Math.ceil(paragraph.length / maxChars));
    }
  }
  return Math.max(hardFloor, lines);
}

export function estimateTextInsertLiftPx(
  body: string | undefined,
  ctx?: InsertLiftEstimateCtx,
): number {
  const { baseLift, lineHeight, belowTime } = bubbleMetrics();
  const text = body ?? "";
  if (text.length === 0) return baseLift;

  const lines = estimateTextVisualLineCount(text, ctx?.maxInnerWidthPx);
  let heightPx = baseLift + (lines - 1) * lineHeight;
  if (lines >= 2) heightPx += belowTime;
  return heightPx;
}

function textBodyFromBlocks(blocks: FscpMessageBlock[]): string | undefined {
  const text = blocks.find((b) => b.kind === "text");
  return text?.kind === "text" ? text.body : undefined;
}

/** Оценка высоты новой строки — fallback / нижняя граница к measure. */
export function estimateBlocksInsertLiftPx(
  blocks: FscpMessageBlock[],
  ctx?: InsertLiftEstimateCtx,
): number {
  const { voiceLift, imageLift, collageLift } = bubbleMetrics();
  if (blocks.some((b) => b.kind === "voice")) return voiceLift;
  const images = blocks.filter((b) => b.kind === "image").length;
  if (images === 1) return imageLift;
  if (images > 1) return collageLift;
  return estimateTextInsertLiftPx(textBodyFromBlocks(blocks), ctx);
}

export function estimateMessageInsertLiftPx(
  content: FscpMessagePlaintext | "decrypting" | "failed",
  ctx?: InsertLiftEstimateCtx,
): number {
  if (content === "decrypting" || content === "failed") return bubbleMetrics().baseLift;
  return estimateBlocksInsertLiftPx(content.blocks, ctx);
}

/** Inner text width: chat strip × 78% − горизонтальный padding пузыря. */
export function maxTextBubbleInnerWidthFromChatInner(innerEl: HTMLElement): number {
  const w = innerEl.clientWidth;
  if (w <= 0) return 0;
  return Math.max(0, Math.floor(w * BUBBLE_MAX_WIDTH_RATIO) - 2 * bubbleMetrics().paddingX);
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
   * Элементы внутри `innerEl` с контр-transform −H→0, пока лента едет +H→0.
   * Только peer-аватар хвоста при append в уже видимую группу (паритет Mobile).
   * Новый пузырь hold не получает — едет с лентой одним transform.
   */
  holdViewportEls?: readonly HTMLElement[];
  /** Вызовается сразу после старта WAAPI-анимаций. */
  onLiftStarted?: () => void;
};

function bumpGeneration(el: HTMLElement): number {
  const generation = (liftGenerationByEl.get(el) ?? 0) + 1;
  liftGenerationByEl.set(el, generation);
  return generation;
}

function cancelLiftAnimations(el: HTMLElement): void {
  const anims = liftAnimationsByEl.get(el);
  if (!anims) return;
  for (const a of anims) {
    try {
      a.cancel();
    } catch {
      /* ignore */
    }
  }
  liftAnimationsByEl.delete(el);
}

function clearLiftStyles(el: HTMLElement): void {
  el.style.transition = "";
  el.style.transform = "";
  el.style.willChange = "";
}

function clearLiftParticipant(el: HTMLElement): void {
  cancelLiftAnimations(el);
  bumpGeneration(el);
  clearLiftStyles(el);
}

function prefersReducedMotion(): boolean {
  return (
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Общий WAAPI translateY(fromY→0). `generationScope` — чья generation инвалидирует cleanup
 * (для hold-avatar scope = inner ленты).
 */
function playTranslateYRelease(
  el: HTMLElement,
  fromY: number,
  durationMs: number,
  generationScope: HTMLElement,
  generation: number,
): void {
  const anim = el.animate(
    [{ transform: `translateY(${fromY}px)` }, { transform: "translateY(0px)" }],
    {
      duration: durationMs,
      easing: CHAT_INSERT_LIFT_EASING,
      fill: "forwards",
    },
  );
  liftAnimationsByEl.set(el, [anim]);
  void anim.finished.then(
    () => {
      if (liftGenerationByEl.get(generationScope) !== generation) return;
      clearLiftStyles(el);
      if (liftAnimationsByEl.get(el)?.[0] === anim) {
        liftAnimationsByEl.delete(el);
      }
    },
    () => {
      /* cancelled */
    },
  );
}

/**
 * После insert у якоря: WAAPI +H→0 на inner (лента + новый пузырь вместе),
 * опционально −H→0 на hold (только avatar). Без sync painted from-state.
 * При h≤0 всё равно зовёт onLiftStarted — чтобы caller снял LiftLock.
 */
export function playChatListInsertLift(
  innerEl: HTMLElement,
  heightPx: number,
  options?: ChatListInsertLiftOptions,
): void {
  const h = Math.max(0, Math.round(heightPx));
  if (h <= 0) {
    options?.onLiftStarted?.();
    return;
  }

  const hold = (options?.holdViewportEls ?? []).filter((el) => innerEl.contains(el));

  cancelLiftAnimations(innerEl);
  for (const el of hold) cancelLiftAnimations(el);

  const generation = bumpGeneration(innerEl);
  for (const el of hold) bumpGeneration(el);

  if (prefersReducedMotion()) {
    clearLiftStyles(innerEl);
    for (const el of hold) clearLiftStyles(el);
    options?.onLiftStarted?.();
    return;
  }

  playTranslateYRelease(innerEl, h, CHAT_INSERT_LIFT_MS, innerEl, generation);
  for (const el of hold) {
    playTranslateYRelease(el, -h, CHAT_INSERT_LIFT_MS, innerEl, generation);
  }

  options?.onLiftStarted?.();
}

/**
 * После прыжка padding base+E→base: sync translateY(-E), затем WAAPI -E→0 (180ms).
 * Паритет Mobile `translateY: -liveComposeGrowth` (лента вниз с pill).
 * Sync from-state обязателен (исключение vs insertLift) — иначе щелчок в кадре pad jump.
 * Inner insertLift аддитивен на messagesInner.
 */
export function playComposeListGrowthRelease(hostEl: HTMLElement, collapsePx: number): void {
  const h = Math.max(0, Math.round(collapsePx));
  if (h <= 0) return;
  const fromY = -h;

  cancelLiftAnimations(hostEl);
  const generation = bumpGeneration(hostEl);

  if (prefersReducedMotion()) {
    clearLiftStyles(hostEl);
    return;
  }

  hostEl.style.transform = `translateY(${fromY}px)`;
  playTranslateYRelease(hostEl, fromY, COMPOSE_LIST_GROWTH_MS, hostEl, generation);
}

export function resetChatListInsertLift(
  innerEl: HTMLElement | null,
  growthHostEl?: HTMLElement | null,
): void {
  if (growthHostEl) clearLiftParticipant(growthHostEl);
  if (!innerEl) return;
  clearLiftParticipant(innerEl);
  for (const el of innerEl.querySelectorAll<HTMLElement>("[data-messages-peer-avatar]")) {
    clearLiftParticipant(el);
  }
}

/** Аватар последней peer-группы в ленте — якорь хвоста для hold при peer-insert. */
export function queryTrailingPeerAvatar(innerEl: HTMLElement): HTMLElement | null {
  const groups = innerEl.querySelectorAll<HTMLElement>("[data-messages-peer-group]");
  const last = groups[groups.length - 1];
  if (!last) return null;
  return last.querySelector<HTMLElement>("[data-messages-peer-avatar]");
}
